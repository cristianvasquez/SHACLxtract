import http from 'node:http'
import rdf from 'rdf-ext'
import { Validator } from 'shacl-engine'
import * as oxigraph from 'oxigraph'

export const EX = 'https://example.org/'
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
export const SH = 'http://www.w3.org/ns/shacl#'
export const XSD = 'http://www.w3.org/2001/XMLSchema#'

const PREFIXES = `@prefix ex: <${EX}> . @prefix xsd: <${XSD}> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n`

export async function parse (text) {
  return rdf.io.dataset.fromText('application/trig', PREFIXES + text)
}

/** The shapes as plain objects, for assertions: { [targetClass]: { iri, properties: { [path]: constraints } } }. */
export function describeShapes (dataset) {
  const quads = [...dataset]
  const objects = (s, p) => quads.filter(q => q.subject.equals(s) && q.predicate.value === p).map(q => q.object)
  const one = (s, p) => objects(s, p)[0]
  const list = node => {
    const items = []
    while (node.value !== RDF + 'nil') { items.push(one(node, RDF + 'first')); node = one(node, RDF + 'rest') }
    return items
  }
  const rule = node => {
    const r = {}
    for (const k of ['datatype', 'nodeKind']) { const v = one(node, SH + k); if (v) r[k] = v.value.replace(XSD, 'xsd:').replace(SH, 'sh:') }
    const classes = objects(node, SH + 'class').map(c => c.value).sort()
    if (classes.length) r.class = classes
    for (const k of ['or', 'and']) { const v = one(node, SH + k); if (v) r[k] = list(v).map(rule) }
    for (const k of ['minCount', 'maxCount']) { const v = one(node, SH + k); if (v) r[k] = Number(v.value) }
    return r
  }
  const out = {}
  for (const q of quads.filter(q => q.predicate.value === RDF + 'type' && q.object.value === SH + 'NodeShape')) {
    const properties = {}
    for (const p of objects(q.subject, SH + 'property')) properties[one(p, SH + 'path').value] = rule(p)
    out[one(q.subject, SH + 'targetClass').value] = { iri: q.subject.value, properties }
  }
  return out
}

export async function validate (shapes, data) {
  const validator = new Validator(shapes, { factory: rdf })
  return validator.validate({ dataset: data })
}

/** An in-process SPARQL endpoint backed by Oxigraph. */
export async function startEndpoint (trig) {
  const store = new oxigraph.Store()
  store.load(PREFIXES + trig, { format: 'application/trig' })
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try {
        const result = store.query(body, { results_format: 'application/sparql-results+json' })
        res.writeHead(200, { 'content-type': 'application/sparql-results+json' })
        res.end(result)
      } catch (e) {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end(String(e))
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/sparql`
  return { url, close: () => new Promise(resolve => server.close(resolve)) }
}
