// Public API: two inputs, one output (an RDF/JS dataset of SHACL shapes).

import rdf from 'rdf-ext'
import { normalizeScope, selectGraph } from './scope.js'
import { profileGraph } from './profile.js'
import { COUNT_POLICIES, propose } from './propose.js'
import { defaultShapeIri, emit, nameShapes } from './emit.js'
import { createClient, profileEndpoint, usedIris } from './endpoint.js'

function normalizeOptions ({ graph, classes = null, countPolicy = 'presence-and-singleton', shapeIri = defaultShapeIri }) {
  if (classes !== null && !(Array.isArray(classes) && classes.every(c => typeof c === 'string' && c !== ''))) {
    throw new TypeError('options.classes must be an array of class IRIs')
  }
  if (!COUNT_POLICIES.includes(countPolicy)) throw new TypeError(`options.countPolicy must be one of: ${COUNT_POLICIES.join(', ')}`)
  if (typeof shapeIri !== 'function') throw new TypeError('options.shapeIri must be a function')
  return {
    scope: normalizeScope(graph),
    targets: classes && [...rdf.termSet(classes.map(c => rdf.namedNode(c)))],
    countPolicy,
    shapeIri
  }
}

const terms = dataset => [...dataset].flatMap(q => [q.subject, q.predicate, q.object])

/**
 * Generate SHACL shapes from an RDF/JS dataset (or any iterable of quads).
 * options.graph: { type: 'default' } | { type: 'named', iri } | { type: 'union', graphs: [...] } (required)
 * options.classes: class IRIs to extract (default: every IRI-valued rdf:type object)
 * options.countPolicy: 'presence-and-singleton' (default) | 'observed-extrema' | 'none'
 * options.shapeIri: classIri => shape IRI (default: classIri + 'Shape')
 */
export async function extractShapes (data, options = {}) {
  if (typeof data?.[Symbol.iterator] !== 'function') throw new TypeError('data must be an iterable of quads')
  const o = normalizeOptions(options)
  const graph = selectGraph(data, o.scope)
  const proposal = propose(profileGraph(graph, o.targets), o)
  const used = rdf.termSet(terms(graph).filter(t => t.termType === 'NamedNode'))
  return emit(proposal, {
    names: nameShapes(proposal.shapes.map(s => s.targetClass), o.shapeIri, used),
    taken: rdf.termSet(terms(data).filter(t => t.termType === 'BlankNode'))
  })
}

/**
 * Generate SHACL shapes from a SPARQL endpoint. Same options as extractShapes, plus:
 * options.fetch: fetch implementation (default: globalThis.fetch)
 * options.headers: extra HTTP headers, for example authorization
 * options.timeout: per-query timeout in milliseconds (default: 60000)
 * Throws an Error with code 'QueryFailed' (failed query) or 'Incomplete' (truncated results).
 */
export async function extractShapesFromEndpoint (endpointUrl, options = {}) {
  const o = normalizeOptions(options)
  const run = createClient(String(endpointUrl), options)
  const proposal = propose(await profileEndpoint(run, o.scope, o.targets), o)
  const classes = proposal.shapes.map(s => s.targetClass)
  const candidates = classes.map(c => o.shapeIri(c.value)).filter(x => typeof x === 'string' && x !== '').map(x => rdf.namedNode(x))
  return emit(proposal, { names: nameShapes(classes, o.shapeIri, await usedIris(run, o.scope, candidates)) })
}
