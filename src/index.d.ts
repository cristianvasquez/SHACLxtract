import type { DatasetCore, Quad } from '@rdfjs/types'

export type GraphSelection =
  | { type: 'default' }
  | { type: 'named', iri: string }
  | { type: 'union', graphs: Array<{ type: 'default' } | { type: 'named', iri: string }> }

export interface ExtractOptions {
  graph: GraphSelection
  /** Class IRIs to extract. Default: every IRI-valued rdf:type object. */
  classes?: string[] | null
  /** Property IRIs that get no property shape. */
  excludeProperties?: string[]
  countPolicy?: 'presence-and-singleton' | 'observed-extrema' | 'none'
  /** Class IRI to shape IRI. Default: class IRI + 'Shape'. */
  shapeIri?: (classIri: string) => string
}

export interface EndpointOptions extends ExtractOptions {
  fetch?: typeof globalThis.fetch
  headers?: Record<string, string>
  timeout?: number
}

/** Shapes in the default graph. Property shapes and lists are blank nodes. */
export function extractShapes (data: Iterable<Quad>, options: ExtractOptions): DatasetCore
export function extractShapesFromEndpoint (endpointUrl: string | URL, options: EndpointOptions): Promise<DatasetCore>
