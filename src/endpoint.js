// Endpoint adapter (manifest: profileEndpoint). Builds the same profile as profileGraph()
// with SPARQL aggregate queries. Only aggregates cross the network.

import rdf from 'rdf-ext'
import { withZeroCount } from './profile.js'
import { ns, sum } from './vocab.js'

/** An Error with code 'QueryFailed' or 'Incomplete', and the query that caused it. */
export const endpointError = (code, message, { query, cause } = {}) =>
  Object.assign(new Error(message, { cause }), { code, query })

/** An IRI between angle brackets; rejects characters that would break the query. */
const iri = term => {
  if (/[\s<>"{}|^`\\]/.test(term.value)) throw new TypeError(`IRI cannot be used in a SPARQL query: ${term.value}`)
  return `<${term.value}>`
}

/** A SPARQL JSON results binding as an RDF/JS term. */
const toTerm = b => ({
  uri: () => rdf.namedNode(b.value),
  bnode: () => rdf.blankNode(b.value),
  literal: () => rdf.literal(b.value, b['xml:lang'] || (b.datatype ? rdf.namedNode(b.datatype) : undefined)),
  'typed-literal': () => rdf.literal(b.value, rdf.namedNode(b.datatype))
}[b.type])()

const int = b => {
  const n = Number(b?.value)
  if (!Number.isInteger(n)) throw endpointError('QueryFailed', `expected an integer, got ${b?.value}`)
  return n
}

/** A SPARQL 1.1 Protocol client: POST query, JSON results. Returns bindings, or a boolean for ASK. */
export const createClient = (url, { fetch = globalThis.fetch, headers = {}, timeout = 60000 } = {}) => async query => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json', ...headers },
    body: query,
    signal: AbortSignal.timeout(timeout)
  }).catch(cause => { throw endpointError('QueryFailed', `request to ${url} failed: ${cause.message}`, { query, cause }) })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw endpointError('QueryFailed', `HTTP ${response.status} from ${url}: ${text.slice(0, 500)}`, { query })
  }
  const json = await response.json().catch(cause => { throw endpointError('QueryFailed', `invalid SPARQL JSON results from ${url}`, { query, cause }) })
  if (typeof json?.boolean === 'boolean') return json.boolean
  if (!Array.isArray(json?.results?.bindings)) throw endpointError('QueryFailed', `invalid SPARQL JSON results from ${url}`, { query })
  return json.results.bindings
}

/**
 * Dataset clause for the scope. The default graph is the endpoint's default graph as configured.
 * Named graphs use FROM, so they form the default graph of each query.
 */
export function datasetClause (scope) {
  const graphs = [...scope]
  if (graphs.length === 1 && graphs[0].termType === 'DefaultGraph') return ''
  if (graphs.some(g => g.termType === 'DefaultGraph')) {
    throw new TypeError('endpoint extraction cannot combine the default graph with named graphs in a union')
  }
  return graphs.map(g => `FROM ${iri(g)}`).join(' ')
}

const TYPE = iri(ns.rdf.type)
const SUB = iri(ns.rdfs.subClassOf)

/** Queries in the selected scope. `rows` checks the row count against a one-row COUNT of the same query. */
const querying = (run, from) => {
  const select = sub => run(`SELECT * ${from} WHERE { { ${sub} } }`)
  return {
    // One aggregate row: a row limit cannot truncate it.
    single: async sub => (await select(sub))[0],
    rows: async sub => {
      const result = await select(sub)
      const [count] = await run(`SELECT (COUNT(*) AS ?rows) ${from} WHERE { { ${sub} } }`)
      if (int(count.rows) !== result.length) {
        throw endpointError('Incomplete', `endpoint returned ${result.length} of ${int(count.rows)} rows`, { query: sub })
      }
      return result
    }
  }
}

const groupBy = (bindings, variable) => bindings.reduce((map, b) => {
  const key = toTerm(b[variable])
  return map.set(key, [...(map.get(key) ?? []), b])
}, rdf.termMap())

async function classProfile ({ single, rows }, c) {
  const members = `{ SELECT DISTINCT ?s WHERE { ?s ${TYPE}/${SUB}* ${iri(c)} } }`
  const values = `${members} ?s ?p ?o .`
  const resources = `${values} FILTER(!isLiteral(?o))`

  const population = int((await single(`SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s ${TYPE}/${SUB}* ${iri(c)} }`)).n)
  const [histogram, valueKinds, resourceCounts, untypedCounts, classCounts] = await Promise.all([
    rows(`SELECT ?p ?k (COUNT(?s) AS ?n) WHERE { { SELECT ?s ?p (COUNT(DISTINCT ?o) AS ?k) WHERE { ${values} } GROUP BY ?s ?p } } GROUP BY ?p ?k`),
    rows(`SELECT DISTINCT ?p ?kind ?dt WHERE { ${values} BIND(IF(isLiteral(?o), "Literal", IF(isBlank(?o), "BlankNode", "IRI")) AS ?kind) BIND(DATATYPE(?o) AS ?dt) }`),
    rows(`SELECT ?p (COUNT(DISTINCT ?o) AS ?n) WHERE { ${resources} } GROUP BY ?p`),
    rows(`SELECT ?p (COUNT(DISTINCT ?o) AS ?n) WHERE { ${resources} FILTER NOT EXISTS { ?o ${TYPE}/${SUB}* ?t FILTER(isIRI(?t)) } } GROUP BY ?p`),
    rows(`SELECT ?p ?d (COUNT(DISTINCT ?o) AS ?n) WHERE { ${resources} ?o ${TYPE}/${SUB}* ?d FILTER(isIRI(?d)) } GROUP BY ?p ?d`)
  ])

  const byProperty = [histogram, valueKinds, resourceCounts, untypedCounts, classCounts].map(r => groupBy(r, 'p'))
  const [hist, kinds, resourceN, untypedN, classN] = byProperty
  const countOf = (map, p) => int(map.get(p)?.[0]?.n ?? { value: '0' })

  const properties = rdf.termMap([...hist.keys()].map(p => {
    const counts = new Map((hist.get(p)).map(b => [int(b.k), int(b.n)]))
    const present = sum([...counts.values()])
    if (present > population) {
      throw endpointError('Incomplete', `inconsistent counts for ${c.value} ${p.value}: ${present} focus nodes with values, population ${population}`)
    }
    const resourceValues = countOf(resourceN, p)
    const kindRows = kinds.get(p) ?? []
    return [p, {
      population,
      counts: withZeroCount(counts, population),
      kinds: new Set(kindRows.map(b => b.kind.value)),
      datatypes: rdf.termSet(kindRows.filter(b => b.kind.value === 'Literal' && b.dt).map(b => toTerm(b.dt))),
      commonClasses: rdf.termSet((classN.get(p) ?? []).filter(b => int(b.n) === resourceValues).map(b => toTerm(b.d))),
      resourceValues,
      untypedResources: countOf(untypedN, p)
    }]
  }))
  if (kinds.size !== hist.size) throw endpointError('Incomplete', `value and count queries disagree on the properties of ${c.value}`)
  return { population, properties }
}

/** targets: class NamedNodes, or null to discover IRI-valued rdf:type objects. */
export async function profileEndpoint (run, scope, targets) {
  const q = querying(run, datasetClause(scope))
  const classes = targets ??
    (await q.rows(`SELECT DISTINCT ?c WHERE { ?s ${TYPE} ?c FILTER(isIRI(?c)) }`)).map(b => toTerm(b.c))
  const unclassified = await q.single(`SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s ?p ?o FILTER NOT EXISTS { ?s ${TYPE}/${SUB}* ?c FILTER(isIRI(?c)) } }`)
  const profiles = rdf.termMap()
  for (const c of classes) profiles.set(c, await classProfile(q, c))

  const common = [...rdf.termSet([...profiles.values()]
    .flatMap(c => [...c.properties.values()])
    .flatMap(p => [...p.commonClasses]))]
  const superClasses = rdf.termMap(common.map(c => [c, rdf.termSet([c])]))
  if (common.length > 1) {
    const list = common.map(iri).join(' ')
    const pairs = await q.rows(`SELECT DISTINCT ?a ?b WHERE { VALUES ?a { ${list} } VALUES ?b { ${list} } ?a ${SUB}* ?b }`)
    pairs.forEach(b => superClasses.get(toTerm(b.a)).add(toTerm(b.b)))
  }

  return { classes: profiles, unclassifiedSubjectCount: int(unclassified.n), superClasses }
}

/** The candidate IRIs that already occur in the selected graphs, as a term set. */
export async function usedIris (run, scope, candidates) {
  const from = datasetClause(scope)
  const chunks = Array.from({ length: Math.ceil(candidates.length / 100) }, (_, i) => candidates.slice(i * 100, i * 100 + 100))
  const found = await Promise.all(chunks.map(chunk =>
    run(`SELECT DISTINCT ?x ${from} WHERE { VALUES ?x { ${chunk.map(iri).join(' ')} } { ?x ?p ?o } UNION { ?s ?x ?o } UNION { ?s ?p ?x } }`)))
  return rdf.termSet(found.flat().map(b => toTerm(b.x)))
}
