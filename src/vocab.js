import rdf from 'rdf-ext'

export const ns = {
  rdf: rdf.namespace('http://www.w3.org/1999/02/22-rdf-syntax-ns#'),
  rdfs: rdf.namespace('http://www.w3.org/2000/01/rdf-schema#'),
  sh: rdf.namespace('http://www.w3.org/ns/shacl#'),
  xsd: rdf.namespace('http://www.w3.org/2001/XMLSchema#')
}

export const kindOf = term =>
  term.termType === 'Literal' ? 'Literal' : term.termType === 'BlankNode' ? 'BlankNode' : 'IRI'

export const byValue = (a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : 0

export const sum = numbers => numbers.reduce((a, b) => a + b, 0)

/** Cache a function of one term. */
export const memoize = fn => {
  const cache = rdf.termMap()
  return term => {
    if (!cache.has(term)) cache.set(term, fn(term))
    return cache.get(term)
  }
}
