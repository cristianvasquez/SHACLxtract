// Explicit graph selection (manifest: Scope, selectGraphs).

import rdf from 'rdf-ext'

const graphTerm = graph => {
  if (graph?.type === 'default') return rdf.defaultGraph()
  if (graph?.type === 'named') {
    if (typeof graph.iri !== 'string' || graph.iri === '') throw new TypeError('graph.iri must be a non-empty string')
    return rdf.namedNode(graph.iri)
  }
  throw new TypeError(`graph.type must be 'default' or 'named' inside a union, got ${graph?.type}`)
}

/** options.graph as a term set of graph names: { type: 'default' | 'named' | 'union' }. */
export function normalizeScope (graph) {
  if (!graph || typeof graph !== 'object') {
    throw new TypeError("options.graph is required: { type: 'default' | 'named' | 'union' }")
  }
  if (graph.type !== 'union') return rdf.termSet([graphTerm(graph)])
  if (!Array.isArray(graph.graphs) || graph.graphs.length === 0) throw new TypeError('graph.graphs must be a non-empty array')
  return rdf.termSet(graph.graphs.map(graphTerm))
}

/** The selected graphs as one set of triples. The dataset removes repeated triples. */
export const selectGraph = (data, scope) =>
  rdf.dataset([...data]
    .filter(quad => scope.has(quad.graph))
    .map(quad => rdf.quad(quad.subject, quad.predicate, quad.object)))
