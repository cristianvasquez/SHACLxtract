import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractShapes, extractShapesFromEndpoint } from '../src/index.js'
import { describeShapes, EX, parse, startEndpoint } from './helpers.js'

const TRIG = `
  ex:Person rdfs:subClassOf ex:Agent .
  ex:Student rdfs:subClassOf ex:Person .
  ex:alice a ex:Person ; ex:name "Alice" ; ex:email "a@x.org", "alice@x.org" ; ex:knows ex:bob .
  ex:bob a ex:Student ; ex:name "Bob" ; ex:email "bob@x.org" ; ex:knows ex:alice, [ ex:x 1 ] .
  ex:carol a ex:Person ; ex:name "Carol"@en ; ex:age 30 .
  ex:doc a ex:Doc ; ex:about "text", 42, ex:alice ; ex:author ex:alice .
  ex:loose ex:p 1 .
  ex:g1 { ex:dan a ex:Person ; ex:name "Dan" ; ex:age 40 . }
  ex:g2 { ex:dan ex:age 41 . ex:erin a ex:Person . }
`

let endpoint
beforeAll(async () => { endpoint = await startEndpoint(TRIG) })
afterAll(async () => { await endpoint.close() })

describe('endpoint and local extraction give the same shapes', () => {
  const scopes = {
    default: { type: 'default' },
    named: { type: 'named', iri: EX + 'g1' },
    union: { type: 'union', graphs: [{ type: 'named', iri: EX + 'g1' }, { type: 'named', iri: EX + 'g2' }] }
  }
  for (const [name, graph] of Object.entries(scopes)) {
    for (const countPolicy of ['presence-and-singleton', 'observed-extrema']) {
      it(`${name} graph, ${countPolicy}`, async () => {
        const local = describeShapes(extractShapes(await parse(TRIG), { graph, countPolicy }))
        const remote = describeShapes(await extractShapesFromEndpoint(endpoint.url, { graph, countPolicy }))
        expect(Object.keys(local).length).toBeGreaterThan(0)
        expect(remote).toEqual(local)
      })
    }
  }

  it('explicit classes, including an empty one', async () => {
    const options = { graph: { type: 'default' }, classes: [EX + 'Agent', EX + 'Robot'] }
    const local = describeShapes(extractShapes(await parse(TRIG), options))
    expect(describeShapes(await extractShapesFromEndpoint(endpoint.url, options))).toEqual(local)
    expect(local[EX + 'Robot'].properties).toEqual({})
  })
})

describe('endpoint failures', () => {
  it('HTTP errors throw QueryFailed', async () => {
    const fetch = async () => new Response('boom', { status: 500 })
    await expect(extractShapesFromEndpoint('http://x/sparql', { graph: { type: 'default' }, fetch }))
      .rejects.toMatchObject({ code: 'QueryFailed' })
  })

  it('silently truncated results throw Incomplete', async () => {
    // An endpoint with a row limit of 1 that reports no error.
    const fetch = async (url, init) => {
      const response = await globalThis.fetch(url, init)
      const json = await response.json()
      if (json.results) json.results.bindings = json.results.bindings.slice(0, 1)
      return new Response(JSON.stringify(json), { status: 200 })
    }
    const error = await extractShapesFromEndpoint(endpoint.url, { graph: { type: 'default' }, fetch }).catch(e => e)
    expect(error.code).toBe('Incomplete')
  })

  it('a union with the default graph is rejected', async () => {
    await expect(extractShapesFromEndpoint(endpoint.url, { graph: { type: 'union', graphs: [{ type: 'default' }, { type: 'named', iri: EX + 'g1' }] } }))
      .rejects.toThrow(/cannot combine the default graph/)
  })

  it('a shape IRI that occurs in the endpoint data is rejected', async () => {
    await expect(extractShapesFromEndpoint(endpoint.url, { graph: { type: 'default' }, shapeIri: () => EX + 'alice', classes: [EX + 'Doc'] }))
      .rejects.toThrow(/already occurs/)
  })
})
