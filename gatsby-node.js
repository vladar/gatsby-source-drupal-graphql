const {
  sourceAllNodes,
  createSchemaCustomization,
  compileNodeQueries,
  readOrGenerateDefaultFragments,
  buildNodeDefinitions,
  loadSchema,
  createDefaultQueryExecutor,
  writeCompiledQueries,
} = require(`gatsby-graphql-source-toolkit`)
const { upperFirst, lowerFirst, flatMap } = require(`lodash`)
const fs = require(`fs-extra`)

const debugDir = __dirname + `/.cache/compiled-graphql-queries`
const fragmentsDir = __dirname + `/src/drupal-fragments`

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

function queryFieldToEntityType(schema, fieldName) {
  const queryType = schema.getQueryType()
  const queryFields = queryType.getFields()

  const match = fieldName.match(/^(.+)Query$/)
  if (
    !match ||
    !match[1] ||
    queryFields[fieldName].type.name !== `EntityQueryResult`
  ) {
    return
  }
  const entityTypeName = upperFirst(match[1])
  return schema.getType(entityTypeName)
}

function findEntityTypes(schema) {
  const queryFields = schema.getQueryType().getFields()

  return Object.keys(queryFields)
    .map(fieldName => queryFieldToEntityType(schema, fieldName))
    .filter(Boolean)
}

function getQueryFieldName(entityType) {
  return lowerFirst(entityType) + `Query`
}

async function createSourcingConfig(gatsbyApi, pluginOptions) {
  // TODO: use joi to validate plugin options?
  const { url, languages = [`EN`] } = pluginOptions

  if (!url) {
    throw new Error("Missing `url` option")
  }

  // Step1. Setup remote schema:
  const defaultExecute = createDefaultQueryExecutor(url)
  const execute = args => {
    // console.log(args.operationName, args.variables)
    return defaultExecute(args)
  }
  const schema = await loadSchema(execute)
  const entityTypes = findEntityTypes(schema)

  // Step2. Configure Gatsby node types
  const gatsbyNodeTypes = flatMap(entityTypes, entityType => {
    const entityFieldName = getQueryFieldName(entityType.name)

    // Entity type can be an object type (e.g. User) OR an interface (e.g. Node)
    // (object types have `getInterfaces` methods, so using it to differentiate)
    const subTypes = entityType.getInterfaces
      ? [entityType]
      : schema.getPossibleTypes(entityType)

    return subTypes.map(type => {
      const idFragmentName = `_${type.name}Id_`

      return {
        remoteTypeName: type.name,
        queries: [
          ...languages.map(
            language => `
          query LIST_${type.name}_${language} {
            ${entityFieldName}(
              # The filters below are important for performance
              # (need to figure out a generic way to filter entity sub-types)
              #
              # filter: {
              #   conditions: [
              #     { operator: EQUAL, field: "status", value: ["1"] }
              #     { operator: EQUAL, field: "type", value: ["article"] }
              #   ]
              # }
              limit: $limit
              offset: $offset
            ) {
              entities(language: ${language}) {
                ...${idFragmentName}
              }
            }
          }
        `
          ),
          `
          fragment ${idFragmentName} on ${type.name} {
            __typename
            entityId
            entityLanguage {
              id
            }
          }
        `,
        ].join("\n"),
      }
    })
  })

  // Step3. Provide (or generate) fragments with fields to be fetched
  const fragments = await readOrGenerateDefaultFragments(fragmentsDir, {
    schema,
    gatsbyNodeTypes,
  })

  // Step4. Compile sourcing queries
  const documents = compileNodeQueries({
    schema,
    gatsbyNodeTypes,
    customFragments: fragments,
  })

  // Write compiled queries for debugging
  await writeCompiledQueries(debugDir, documents)

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
