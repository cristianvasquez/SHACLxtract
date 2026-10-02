// Local profile (manifest: index, profile). The endpoint adapter builds the same structure:
//
//   Profile         = { classes: TermMap<Class, ClassProfile>, unclassifiedSubjectCount,
//                       superClasses: TermMap<Class, TermSet<Class>> }
//   ClassProfile    = { population, properties: TermMap<Property, PropertyProfile> }
//   PropertyProfile = { population, counts: Map<k, n>, kinds: Set<kind>, datatypes: TermSet,
//                       commonClasses: TermSet, resourceValues, untypedResources }
//
// counts maps a distinct-value count k to the number of focus nodes with k values, k = 0 included.
// superClasses holds, for each common class, the common classes it is a subclass of (itself included).

import rdf from 'rdf-ext'
import { kindOf, memoize, ns, sum } from './vocab.js'

const objects = (graph, subject, predicate) => [...graph.match(subject, predicate)].map(q => q.object)

/** rdfs:subClassOf* from a node. Terminates on cycles. */
const superClosure = graph => memoize(start => {
  const seen = rdf.termSet([start])
  const visit = node => objects(graph, node, ns.rdfs.subClassOf)
    .filter(next => next.termType !== 'Literal' && !seen.has(next))
    .forEach(next => { seen.add(next); visit(next) })
  visit(start)
  return seen
})

/** IRIs reachable by rdf:type/rdfs:subClassOf*, as sh:targetClass and sh:class see them. */
const memberships = (graph, closure) => memoize(node => rdf.termSet(
  objects(graph, node, ns.rdf.type)
    .filter(type => type.termType !== 'Literal')
    .flatMap(type => [...closure(type)])
    .filter(c => c.termType === 'NamedNode')))

const intersect = sets => sets.reduce((a, b) => rdf.termSet([...a].filter(x => b.has(x))))

const histogram = sizes => sizes.reduce((h, k) => h.set(k, (h.get(k) ?? 0) + 1), new Map())

const propertyProfile = (graph, classesOf, members, property) => {
  const valueSets = members.map(s => rdf.termSet(objects(graph, s, property)))
  const values = [...rdf.termSet(valueSets.flatMap(set => [...set]))]
  const literals = values.filter(v => v.termType === 'Literal')
  const resources = values.filter(v => v.termType !== 'Literal')
  return {
    population: members.length,
    counts: histogram(valueSets.map(set => set.size)),
    kinds: new Set(values.map(kindOf)),
    datatypes: rdf.termSet(literals.map(l => l.datatype)),
    commonClasses: resources.length ? intersect(resources.map(classesOf)) : rdf.termSet(),
    resourceValues: resources.length,
    untypedResources: resources.filter(r => classesOf(r).size === 0).length
  }
}

const classProfile = (graph, classesOf, members) => {
  const properties = rdf.termSet(members.flatMap(s => [...graph.match(s)].map(q => q.predicate)))
  return {
    population: members.length,
    properties: rdf.termMap([...properties].map(p => [p, propertyProfile(graph, classesOf, members, p)]))
  }
}

/** targets: class NamedNodes, or null to discover IRI-valued rdf:type objects. */
export function profileGraph (graph, targets) {
  const closure = superClosure(graph)
  const classesOf = memberships(graph, closure)
  const subjects = [...rdf.termSet([...graph].map(q => q.subject))]
  const classes = targets ?? [...rdf.termSet([...graph.match(null, ns.rdf.type)]
    .map(q => q.object)
    .filter(c => c.termType === 'NamedNode'))]

  const profiles = rdf.termMap(classes.map(c =>
    [c, classProfile(graph, classesOf, subjects.filter(s => classesOf(s).has(c)))]))

  const common = rdf.termSet([...profiles.values()]
    .flatMap(c => [...c.properties.values()])
    .flatMap(p => [...p.commonClasses]))

  return {
    classes: profiles,
    unclassifiedSubjectCount: subjects.filter(s => classesOf(s).size === 0).length,
    superClasses: rdf.termMap([...common].map(c => [c, rdf.termSet([...closure(c)].filter(x => common.has(x)))]))
  }
}

/** Zero counts follow from the population: counts[0] = population - focus nodes with values. */
export const withZeroCount = (counts, population) => {
  const present = sum([...counts.values()])
  return population > present ? new Map([...counts, [0, population - present]]) : counts
}
