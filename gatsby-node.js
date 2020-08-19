const {
  sourceAllNodes,
  createSchemaCustomization,
  compileNodeQueries,
  readOrGenerateDefaultFragments,
  buildNodeDefinitions,
  loadSchema,
  createDefaultQueryExecutor,
} = require(`gatsby-graphql-source-toolkit`)
const { print } = require(`gatsby/graphql`)
const fs = require(`fs-extra`)

const PaginateDrupal = {
  name: "LimitOffsetDrupal",
  expectedVariableNames: [`limit`, `offset`],
  start() {
    return {
      variables: { limit: 100, offset: 0 },
      hasNextPage: true,
    }
  },
  next(state, page) {
    const limit = Number(state.variables.limit) || 100
    const offset = Number(state.variables.offset) + limit
    return {
      variables: { limit, offset },
      hasNextPage: page.entities.length === limit,
    }
  },
  concat(result, page) {
    return result.entities.concat(page)
  },
  getItems(pageOrResult) {
    return pageOrResult.entities
  },
}

async function writeCompiledQueries(nodeDocs) {
  const debugDir = __dirname + `/.cache/compiled-graphql-queries`
  await fs.ensureDir(debugDir)
  for (const [remoteTypeName, document] of nodeDocs) {
    await fs.writeFile(debugDir + `/${remoteTypeName}.graphql`, print(document))
  }
}

async function createSourcingConfig(gatsbyApi, pluginOptions) {
  // TODO: use joi to validate plugin options?
  const { url, languages = [`EN`] } = pluginOptions

  if (!url) {
    throw new Error("Missing `url` option")
  }

  // Step1. Setup remote schema:
  const execute = createDefaultQueryExecutor(url)
  const schema = await loadSchema(execute)

  // const entityInterface = schema.getType(`Entity`)
  // const allEntities = schema.getPossibleTypes(entityInterface)

  // Step2. Configure Gatsby node types
  const gatsbyNodeTypes = [
    {
      remoteTypeName: `NodeArticle`,
      queries: [
        ...languages.map(language => `
          query LIST_NodeArticle_${language} {
            nodeQuery(
              filter: {
                conditions: [
                  { operator: EQUAL, field: "status", value: ["1"] }
                  { operator: EQUAL, field: "type", value: ["article"] }
                ]
              }
              limit: $limit
              offset: $offset
            ) {
              entities(language: ${language}) { ..._NodeArticleId_ }
            }
          }
        `),
        `
          fragment _NodeArticleId_ on NodeArticle {
            __typename
            entityId
            entityLanguage {
              id
            }
          }
        `
      ].join("\n")
    },
    {
      remoteTypeName: `NodePage`,
      queries: `
        query LIST_NodePage {
          nodeQuery(limit: $limit offset: $offset) {
            entities { ..._NodePageId_ }
          }
        }
        fragment _NodePageId_ on NodePage {
          __typename
          entityId
          entityLanguage {
            id
          }
        }
      `,
    },
  ]

  // Not sure yet how to map other types to root query fields
  // TODO
  const type = schema.getType(`Entity`)
  const nodeTypes = schema.getPossibleTypes(type)
  const dynamicTypes = nodeTypes
    .filter(type => !gatsbyNodeTypes.some(t => t.remoteTypeName === type.name))
    .map(type => {
      const idFragmentName = `_${type.name}Id_`
      return {
        remoteTypeName: type.name,
        queries: `
          query LIST_${type.name} {
            commentQuery(limit: $limit offset: $offset) {
              entities {
                ...${idFragmentName}
              }
            }
          }
          fragment ${idFragmentName} on ${type.name} {
            __typename
            entityId
            entityLanguage {
              id
            }
          }
        `,
      }
    })

  gatsbyNodeTypes.push(...dynamicTypes)

  // Step3. Provide (or generate) fragments with fields to be fetched
  const fragments = await readOrGenerateDefaultFragments(
    `./src/drupal-fragments`,
    { schema, gatsbyNodeTypes }
  )

  // Step4. Compile sourcing queries
  const documents = compileNodeQueries({
    schema,
    gatsbyNodeTypes,
    customFragments: fragments,
  })

  // Write compiled queries for debugging
  await writeCompiledQueries(documents)

  return {
    gatsbyApi,
    schema,
    execute,
    gatsbyTypePrefix: `Drupal`,
    gatsbyNodeDefs: buildNodeDefinitions({ gatsbyNodeTypes, documents }),
    paginationAdapters: [PaginateDrupal],
  }
}

// FIXME:
const pluginOptions = {
  url: process.env.DRUPAL_GRAPHQL_URL,
  languages: [`EN`, `ES`],
}

exports.sourceNodes = async gatsbyApi => {
  const config = await createSourcingConfig(gatsbyApi, pluginOptions)

  // Step5. Add explicit types to gatsby schema
  await createSchemaCustomization(config)

  // Step6. Source nodes
  await sourceAllNodes(config)
}
