// RDF emission (manifest: ShapeNaming, emit).

import rdf from 'rdf-ext'
import { ns } from './vocab.js'

export const defaultShapeIri = classIri => classIri + 'Shape'

/**
 * Map each target class to its shape node. Fails when two classes get the same shape IRI,
 * or when a shape IRI is in `used` (a term set of IRIs that occur in the source graph).
 */
export function nameShapes (classes, shapeIri, used) {
  const names = rdf.termMap(classes.map(c => {
    const name = shapeIri(c.value)
    if (typeof name !== 'string' || name === '') throw new TypeError(`shapeIri returned no IRI for ${c.value}`)
    return [c, rdf.namedNode(name)]
  }))
  const owners = rdf.termMap()
  for (const [c, name] of names) {
    if (owners.has(name)) throw new Error(`shape IRI collision: ${owners.get(name).value} and ${c.value} both map to ${name.value}`)
    if (used.has(name)) throw new Error(`shape IRI ${name.value} for ${c.value} already occurs in the source graph`)
    owners.set(name, c)
  }
  return names
}

const KINDS = {
  IRI: ns.sh.IRI,
  BlankNode: ns.sh.BlankNode,
  Literal: ns.sh.Literal,
  'BlankNode,IRI': ns.sh.BlankNodeOrIRI,
  'IRI,Literal': ns.sh.IRIOrLiteral,
  'BlankNode,Literal': ns.sh.BlankNodeOrLiteral
}

const integer = n => rdf.literal(String(n), ns.xsd.integer)
const atomic = rule => rule.type !== 'and' && rule.type !== 'or'
const atMostOne = (rules, type) => rules.filter(r => r.type === type).length <= 1

/** Blank-node labels shx1, shx2, ... that skip the labels in `taken`. */
const blankNodes = taken => {
  let n = 0
  return () => {
    let node
    do node = rdf.blankNode(`shx${++n}`); while (taken.has(node))
    return node
  }
}

/** The shapes as a dataset in the default graph. `taken`: blank nodes of the input, not reused. */
export function emit (proposal, { names, taken = rdf.termSet() }) {
  const out = rdf.dataset()
  const fresh = blankNodes(taken)
  const add = (s, p, o) => out.add(rdf.quad(s, p, o))

  const list = items => items.reduceRight((rest, item) => {
    const cell = fresh()
    add(cell, ns.rdf.first, item)
    add(cell, ns.rdf.rest, rest)
    return cell
  }, ns.rdf.nil)

  const member = rule => {
    const node = fresh()
    writeRule(node, rule)
    return node
  }

  const writeRule = (node, rule) => ({
    any: () => {},
    kind: () => {
      const kind = KINDS[[...rule.kinds].sort().join(',')]
      if (kind) add(node, ns.sh.nodeKind, kind)
    },
    datatype: () => add(node, ns.sh.datatype, rule.term),
    class: () => add(node, ns.sh.class, rule.term),
    // Constraints of one shape are conjunctive; several sh:class values are valid.
    // SHACL allows at most one sh:datatype and one sh:nodeKind per shape.
    and: () => rule.rules.every(atomic) && atMostOne(rule.rules, 'datatype') && atMostOne(rule.rules, 'kind')
      ? rule.rules.forEach(r => writeRule(node, r))
      : add(node, ns.sh.and, list(rule.rules.map(member))),
    or: () => add(node, ns.sh.or, list(rule.rules.map(member)))
  }[rule.type])()

  for (const shape of proposal.shapes) {
    const node = names.get(shape.targetClass)
    add(node, ns.rdf.type, ns.sh.NodeShape)
    add(node, ns.sh.targetClass, shape.targetClass)
    for (const { path, bounds, rule } of shape.properties) {
      const property = fresh()
      add(node, ns.sh.property, property)
      add(property, ns.sh.path, path)
      if (bounds.min !== undefined) add(property, ns.sh.minCount, integer(bounds.min))
      if (bounds.max !== undefined) add(property, ns.sh.maxCount, integer(bounds.max))
      writeRule(property, rule)
    }
  }
  return out
}
