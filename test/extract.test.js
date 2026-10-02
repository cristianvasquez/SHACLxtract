import { describe, expect, it } from 'vitest'
import { extractShapes } from '../src/index.js'
import { describeShapes, EX, parse, RDF, validate } from './helpers.js'

const DEFAULT = { graph: { type: 'default' } }

const PEOPLE = `
  ex:alice a ex:Person ; ex:name "Alice" ; ex:email "a@x.org", "alice@x.org" .
  ex:bob a ex:Person ; ex:name "Bob" ; ex:email "bob@x.org" .
  ex:carol a ex:Person ; ex:name "Carol" .
`

async function shapesOf (text, options = DEFAULT) {
  const data = await parse(text)
  const shapes = await extractShapes(data, options)
  return { data, shapes, d: describeShapes(shapes) }
}

describe('readme example', () => {
  it('requires one string name; email is a string without bounds', async () => {
    const { d } = await shapesOf(PEOPLE)
    expect(d[EX + 'Person'].iri).toBe(EX + 'PersonShape')
    expect(d[EX + 'Person'].properties).toEqual({
      [EX + 'name']: { datatype: 'xsd:string', minCount: 1, maxCount: 1 },
      [EX + 'email']: { datatype: 'xsd:string' },
      [RDF + 'type']: { nodeKind: 'sh:IRI' }
    })
  })

  it('the source data conforms; negative examples fail', async () => {
    const { data, shapes } = await shapesOf(PEOPLE)
    expect((await validate(shapes, data)).conforms).toBe(true)
    for (const bad of [
      'ex:dan a ex:Person .',
      'ex:dan a ex:Person ; ex:name "D", "E" .',
      'ex:dan a ex:Person ; ex:name 42 .',
      'ex:dan a ex:Person ; ex:name "D" ; ex:email ex:mailbox .'
    ]) {
      expect((await validate(shapes, await parse(bad))).conforms, bad).toBe(false)
    }
  })

  it('observed-extrema gives the observed maximum', async () => {
    const { d } = await shapesOf(PEOPLE, { ...DEFAULT, countPolicy: 'observed-extrema' })
    expect(d[EX + 'Person'].properties[EX + 'email']).toEqual({ datatype: 'xsd:string', maxCount: 2 })
  })

  it("countPolicy 'none' emits no bounds", async () => {
    const { d } = await shapesOf(PEOPLE, { ...DEFAULT, countPolicy: 'none' })
    expect(d[EX + 'Person'].properties[EX + 'name']).toEqual({ datatype: 'xsd:string' })
  })
})

describe('acceptance cases', () => {
  it('duplicate quads and input order do not change the result', async () => {
    const a = (await shapesOf(PEOPLE)).d
    const shuffled = `
      ex:carol ex:name "Carol" . ex:bob ex:email "bob@x.org" . ex:alice ex:email "alice@x.org", "a@x.org" .
      ex:alice ex:name "Alice" . ex:bob ex:name "Bob" . ex:bob ex:name "Bob" .
      ex:carol a ex:Person . ex:bob a ex:Person . ex:alice a ex:Person . ex:alice a ex:Person .
    `
    expect((await shapesOf(shuffled)).d).toEqual(a)
  })

  it('multiple types on a value do not inflate its count', async () => {
    const { d } = await shapesOf(`
      ex:a a ex:Doc ; ex:author ex:p .
      ex:b a ex:Doc ; ex:author ex:q .
      ex:p a ex:Person, ex:Agent . ex:q a ex:Person, ex:Agent .
    `, { ...DEFAULT, classes: [EX + 'Doc'] })
    expect(d[EX + 'Doc'].properties[EX + 'author']).toEqual({ nodeKind: 'sh:IRI', class: [EX + 'Agent', EX + 'Person'], minCount: 1, maxCount: 1 })
  })

  it('several common classes reduce to the most specific; output conforms', async () => {
    const { data, shapes, d } = await shapesOf(`
      ex:Person rdfs:subClassOf ex:Agent .
      ex:a a ex:Doc ; ex:author ex:p .
      ex:p a ex:Person .
    `, { ...DEFAULT, classes: [EX + 'Doc'] })
    expect(d[EX + 'Doc'].properties[EX + 'author'].class).toEqual([EX + 'Person'])
    expect((await validate(shapes, data)).conforms).toBe(true)
  })

  it('an untyped resource value removes sh:class', async () => {
    const { d } = await shapesOf(`
      ex:a a ex:Doc ; ex:author ex:p .
      ex:b a ex:Doc ; ex:author ex:q .
      ex:p a ex:Person .
    `, { ...DEFAULT, classes: [EX + 'Doc'] })
    expect(d[EX + 'Doc'].properties[EX + 'author']).toEqual({ nodeKind: 'sh:IRI', minCount: 1, maxCount: 1 })
  })

  it('mixed literal and resource values give sh:or; output conforms', async () => {
    const { data, shapes, d } = await shapesOf(`
      ex:a a ex:Doc ; ex:about "text" .
      ex:b a ex:Doc ; ex:about 42 .
      ex:c a ex:Doc ; ex:about ex:topic .
      ex:topic a ex:Topic .
    `, { ...DEFAULT, classes: [EX + 'Doc'] })
    expect(d[EX + 'Doc'].properties[EX + 'about']).toEqual({
      minCount: 1,
      maxCount: 1,
      or: [{ datatype: 'xsd:integer' }, { datatype: 'xsd:string' }, { nodeKind: 'sh:IRI', class: [EX + 'Topic'] }]
    })
    expect((await validate(shapes, data)).conforms).toBe(true)
    expect((await validate(shapes, await parse('ex:d a ex:Doc ; ex:about true .'))).conforms).toBe(false)
  })

  it('IRI and blank-node values give sh:BlankNodeOrIRI', async () => {
    const { data, shapes, d } = await shapesOf(`
      ex:a a ex:Doc ; ex:part ex:p .
      ex:b a ex:Doc ; ex:part [ ex:x 1 ] .
    `, { ...DEFAULT, classes: [EX + 'Doc'] })
    expect(d[EX + 'Doc'].properties[EX + 'part']).toEqual({ nodeKind: 'sh:BlankNodeOrIRI', minCount: 1, maxCount: 1 })
    expect((await validate(shapes, data)).conforms).toBe(true)
  })

  it('subclass instances join the superclass target; cycles terminate', async () => {
    const { data, shapes, d } = await shapesOf(`
      ex:A rdfs:subClassOf ex:B . ex:B rdfs:subClassOf ex:A .
      ex:Student rdfs:subClassOf ex:Person .
      ex:s a ex:Student ; ex:name "S" .
      ex:p a ex:Person ; ex:name "P" .
      ex:x a ex:A ; ex:v 1 .
    `, { ...DEFAULT, classes: [EX + 'Person', EX + 'B'] })
    expect(d[EX + 'Person'].properties[EX + 'name']).toEqual({ datatype: 'xsd:string', minCount: 1, maxCount: 1 })
    expect(d[EX + 'B'].properties[EX + 'v']).toEqual({ datatype: 'xsd:integer', minCount: 1, maxCount: 1 })
    expect((await validate(shapes, data)).conforms).toBe(true)
  })

  it('rdf:type gets no bounds', async () => {
    const { data, shapes } = await shapesOf(PEOPLE)
    const extra = await parse('ex:dan a ex:Person, ex:Employee ; ex:name "Dan" .')
    expect((await validate(shapes, extra)).conforms).toBe(true)
    expect((await validate(shapes, data)).conforms).toBe(true)
  })

  it('language-tagged literals use rdf:langString', async () => {
    const { d } = await shapesOf('ex:a a ex:Doc ; ex:title "Titre"@fr .')
    expect(d[EX + 'Doc'].properties[EX + 'title'].datatype).toBe(RDF + 'langString')
  })

  it('an explicitly selected empty class gives an empty node shape', async () => {
    const { d } = await shapesOf(PEOPLE, { ...DEFAULT, classes: [EX + 'Robot'] })
    expect(d).toEqual({ [EX + 'Robot']: { iri: EX + 'RobotShape', properties: {} } })
  })

  it('an ill-typed source literal is reported by validation, not hidden', async () => {
    const { data, shapes } = await shapesOf('ex:a a ex:Doc ; ex:n "x"^^xsd:integer .')
    expect((await validate(shapes, data)).conforms).toBe(false)
  })
})

describe('graph selection', () => {
  const TRIG = `
    ex:alice a ex:Person ; ex:name "Alice" .
    ex:g1 { ex:bob a ex:Person ; ex:name "Bob" ; ex:age 30 . }
    ex:g2 { ex:bob ex:age 31 . ex:carol a ex:Person . }
  `

  it('requires an explicit graph', async () => {
    await expect(extractShapes(await parse(TRIG), {})).rejects.toThrow(/options.graph is required/)
  })

  it('a named graph ignores other graphs', async () => {
    const { d } = await shapesOf(TRIG, { graph: { type: 'named', iri: EX + 'g1' } })
    expect(d[EX + 'Person'].properties[EX + 'age']).toEqual({ datatype: 'xsd:integer', minCount: 1, maxCount: 1 })
  })

  it('a union merges the selected graphs', async () => {
    const { d } = await shapesOf(TRIG, { graph: { type: 'union', graphs: [{ type: 'named', iri: EX + 'g1' }, { type: 'named', iri: EX + 'g2' }] } })
    // bob has two ages in the union; carol has none.
    expect(d[EX + 'Person'].properties[EX + 'age']).toEqual({ datatype: 'xsd:integer' })
  })

  it('identical triples in different graphs count once in a union', async () => {
    const { d } = await shapesOf(`
      ex:g1 { ex:a a ex:Doc ; ex:n 1 . }
      ex:g2 { ex:a a ex:Doc ; ex:n 1 . }
    `, { graph: { type: 'union', graphs: [{ type: 'named', iri: EX + 'g1' }, { type: 'named', iri: EX + 'g2' }] } })
    expect(d[EX + 'Doc'].properties[EX + 'n']).toEqual({ datatype: 'xsd:integer', minCount: 1, maxCount: 1 })
  })
})

describe('shape naming', () => {
  it('fails when two classes map to the same shape IRI', async () => {
    await expect(extractShapes(await parse('ex:a a ex:A . ex:b a ex:B .'), { ...DEFAULT, shapeIri: () => EX + 'S' }))
      .rejects.toThrow(/collision/)
  })

  it('fails when a shape IRI occurs in the source graph', async () => {
    await expect(extractShapes(await parse('ex:a a ex:A . ex:AShape ex:p 1 .'), DEFAULT))
      .rejects.toThrow(/already occurs/)
  })

  it('accepts a custom naming function', async () => {
    const { d } = await shapesOf('ex:a a ex:A .', { ...DEFAULT, shapeIri: c => 'urn:shape:' + encodeURIComponent(c) })
    expect(d[EX + 'A'].iri).toBe('urn:shape:' + encodeURIComponent(EX + 'A'))
  })

  it('emitted blank nodes do not reuse input blank-node labels', async () => {
    const data = await parse('ex:a a ex:A ; ex:p 1 .')
    const shapes = await extractShapes(data, DEFAULT)
    const labels = new Set([...data].flatMap(q => [q.subject, q.object]).filter(t => t.termType === 'BlankNode').map(t => t.value))
    for (const q of shapes) for (const t of [q.subject, q.object]) if (t.termType === 'BlankNode') expect(labels.has(t.value)).toBe(false)
  })
})
