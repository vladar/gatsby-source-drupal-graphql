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

async function createSourcingConfig(gatsbyApi) {
  // Step1. Setup remote schema:
  if (!process.env.DRUPAL_GRAPHQL_URL) {
    throw new Error("Missing process.env.DRUPAL_GRAPHQL_URL")
  }
  const execute = createDefaultQueryExecutor(process.env.DRUPAL_GRAPHQL_URL)
  const schema = await loadSchema(execute)

  // Step2. Configure Gatsby node types
  const gatsbyNodeTypes = [
    {
      remoteTypeName: `NodeArticle`,
      remoteIdFields: [`__typename`, `entityId`],
      queries: `
        query LIST_NodeArticle {
          nodeQuery(limit: $limit offset: $offset) {
            entities
          }
        }`,
    },
    {
      remoteTypeName: `NodePage`,
      remoteIdFields: [`__typename`, `entityId`],
      queries: `
        query LIST_NodePage {
          nodeQuery(limit: $limit offset: $offset) {
            entities
          }
        }`,
    },
  ]

  // Not sure yet how to map other types to root query fields
  // TODO
  const type = schema.getType(`Entity`)
  const nodeTypes = schema.getPossibleTypes(type)
  const dynamicTypes = nodeTypes
    .filter(type => !gatsbyNodeTypes.some(t => t.remoteTypeName === type.name))
    .map(type => {
      return {
        remoteTypeName: type.name,
        remoteIdFields: [`__typename`, `entityId`],
        queries: `
          query LIST_${type.name} {
            commentQuery(limit: $limit offset: $offset) { entities }
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
    execute: function (...args) {
      console.log(args[0].operationName, args[0].variables)
      return execute(...args)
    },
    gatsbyTypePrefix: `Drupal_`,
    gatsbyNodeDefs: buildNodeDefinitions({ gatsbyNodeTypes, documents }),
    paginationAdapters: [PaginateDrupal],
  }
}

exports.sourceNodes = async (gatsbyApi, pluginOptions) => {
  const config = await createSourcingConfig(gatsbyApi)

  // Step5. Add explicit types to gatsby schema
  await createSchemaCustomization(config)

  // Step6. Source nodes
  await sourceAllNodes(config)
}
