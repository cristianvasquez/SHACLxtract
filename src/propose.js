// Constraint inference (manifest: inferBounds, inferValues, propose).
//
// ValueRule = { type: 'any' } | { type: 'kind', kinds: [kind] } | { type: 'datatype', term }
//           | { type: 'class', term } | { type: 'and', rules } | { type: 'or', rules }

import { byValue, ns } from './vocab.js'

export const COUNT_POLICIES = ['presence-and-singleton', 'observed-extrema', 'none']

/** Bounds from a count histogram, or null when no focus node has a value. */
export function inferBounds (policy, counts) {
  const keys = [...counts].filter(([, n]) => n > 0).map(([k]) => k)
  if (!keys.some(k => k > 0)) return null
  const min = Math.min(...keys)
  const max = Math.max(...keys)
  return {
    'presence-and-singleton': () => ({ ...(min >= 1 && { min: 1 }), ...(max <= 1 && { max: 1 }) }),
    'observed-extrema': () => ({ ...(min > 0 && { min }), max }),
    none: () => ({})
  }[policy]()
}

/** Drop a class when another member is a subclass of it; keep all members of a subclass cycle. */
export const mostSpecific = (classes, superClasses) => {
  const above = (c, d) => superClasses.get(c)?.has(d) ?? false
  const all = [...classes]
  return all.filter(c => !all.some(d => !d.equals(c) && above(d, c) && !above(c, d))).sort(byValue)
}

const combine = (type, rules) => {
  const flat = rules.flatMap(r => r.type === type ? r.rules : [r])
  return flat.length === 1 ? flat[0] : { type, rules: flat }
}

export function inferValues (property, superClasses) {
  const literal = property.kinds.has('Literal')
    ? [...property.datatypes].sort(byValue).map(term => ({ type: 'datatype', term }))
    : []
  const kinds = ['BlankNode', 'IRI'].filter(k => property.kinds.has(k))
  const resource = kinds.length
    ? [combine('and', [{ type: 'kind', kinds }, ...mostSpecific(property.commonClasses, superClasses).map(term => ({ type: 'class', term }))])]
    : []
  const branches = [...literal, ...resource]
  return branches.length ? combine('or', branches) : { type: 'any' }
}

const datatypesOf = rule => rule.type === 'datatype' ? [rule.term] : (rule.rules ?? []).flatMap(datatypesOf)

const propertyShape = (policy, superClasses) => ([path, evidence]) => {
  const bounds = inferBounds(policy, evidence.counts)
  if (bounds === null) return []
  // rdf:type gets no bounds: one observed type must not reject a second type later.
  return [{ path, bounds: path.equals(ns.rdf.type) ? {} : bounds, rule: inferValues(evidence, superClasses), evidence }]
}

/** Shapes sorted by class and path, with their evidence, and notices. */
export function propose (profile, { countPolicy, excluded }) {
  const shapes = [...profile.classes]
    .sort(([a], [b]) => byValue(a, b))
    .map(([targetClass, { population, properties }]) => ({
      targetClass,
      population,
      properties: [...properties]
        .filter(([path]) => !excluded?.has(path))
        .sort(([a], [b]) => byValue(a, b))
        .flatMap(propertyShape(countPolicy, profile.superClasses))
    }))
  const datatypes = [...new Map(shapes
    .flatMap(s => s.properties)
    .flatMap(p => datatypesOf(p.rule))
    .map(d => [d.value, d])).values()]
  const notices = [
    ...shapes.filter(s => s.population === 0).map(s => ({ type: 'EmptyTarget', term: s.targetClass })),
    ...(profile.unclassifiedSubjectCount > 0 ? [{ type: 'UnclassifiedSubjects', count: profile.unclassifiedSubjectCount }] : []),
    ...datatypes.sort(byValue).map(term => ({ type: 'DatatypeUnchecked', term }))
  ]
  return { shapes, notices }
}
