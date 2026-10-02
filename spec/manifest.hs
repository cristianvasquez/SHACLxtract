-- | Proposed algorithm contract for SHACLxtract, not an implementation.
-- Signature-level specification in the style of rdf-cli/spec/manifest.hs.
-- Input: RDF instance data (local dataset or SPARQL endpoint).
-- Output: candidate SHACL shapes. Evidence and notices stay internal in v1.
--
-- Read this as a pipeline:
--   local:    selected graph -> index -> profile -> proposed shapes -> RDF
--   endpoint: selected graph -> aggregate queries -> profile -> (same)
--
-- Example: Person instances Alice, Bob, Carol have name counts [1,1,1]
-- and email counts [2,1,0]. Both properties contain only xsd:string values.
--   name:  Histogram {1 -> 3}; minCount 1, maxCount 1, datatype xsd:string.
--   email: Histogram {0 -> 1, 1 -> 1, 2 -> 1}; datatype xsd:string only.
-- The default rule does not infer maxCount 2 from the email sample.
-- See readme.md for the corresponding SHACL output.
module SHACLxtract.Manifest where

import Data.Map.Strict (Map)
import Data.Set (Set)
import Numeric.Natural (Natural)

type Iri = String
data Resource = IRI Iri | Blank String deriving (Eq, Ord, Show)
data Value = Resource Resource | Literal String Iri (Maybe String)
  deriving (Eq, Ord, Show)
data Graph = DefaultGraph | NamedGraph Resource deriving (Eq, Ord, Show)
data Quad = Quad Resource Iri Value Graph deriving (Eq, Ord, Show)
type Dataset = Set Quad
type Triple = (Resource, Iri, Value)

-- Graph selection is required. There is no implicit union.
-- Union deduplicates triples across the selected graphs.
-- To keep graphs separate, the caller runs extraction once per graph.
data Scope = OneGraph Graph | UnionGraphs (Set Graph)
data ScopedGraph = ScopedGraph
  { sourceGraphs :: Set Graph
  , triples :: Set Triple
  }

-- Discover classes from IRI-valued rdf:type objects, or select them explicitly.
-- Membership includes rdf:type/rdfs:subClassOf* in the selected data graph,
-- matching sh:targetClass. No general RDFS/OWL entailment is assumed.
-- Closure must terminate on subclass cycles. Never borrow types from other graphs.
data Targets = DiscoverClasses | Classes (Set Iri)
data Index = Index
  { outgoing :: Map Resource (Map Iri (Set Value))
  , memberships :: Map Resource (Set Iri)
  , instances :: Map Iri (Set Resource)
  }

-- Read all types before classifying object values: input order is arbitrary.
selectGraphs :: Scope -> Dataset -> ScopedGraph
index :: ScopedGraph -> Index

-- A property histogram counts DISTINCT RDF terms per focus node.
-- Lexically different typed literals remain different terms.
-- Every target contributes once, including a zero for a missing property.
type Histogram = Map Natural Natural -- value count -> number of focus nodes
data NodeKind = IsIRI | IsBlank | IsLiteral deriving (Eq, Ord, Show)
data PropertyProfile = PropertyProfile
  { population :: Natural
  , counts :: Histogram
  , kinds :: Set NodeKind
  , datatypes :: Set Iri
  , commonClasses :: Set Iri
  , untypedResources :: Natural
  }
-- commonClasses = intersection of memberships over ALL resource values.
-- An untyped resource contributes the empty set, not an omitted observation.
-- Memberships include superclass closure, so the intersection holds
-- superclasses too; inferValues reduces it to the most specific classes.
-- Cardinalities count values once even when each value has several classes.
data ClassProfile = ClassProfile
  { classPopulation :: Natural
  , propertyProfiles :: Map Iri PropertyProfile
  }
data Profile = Profile
  { classProfiles :: Map Iri ClassProfile
  , unclassifiedSubjectCount :: Natural
  }
-- Properties = union of outgoing predicates across the class's instances,
-- including rdf:type. Do not invent absent properties from an ontology.
-- Retain explicitly selected empty classes with population 0 and no properties.
-- unclassifiedSubjectCount counts distinct subjects with empty memberships,
-- regardless of which classes the caller selected.
profile :: Targets -> Index -> Profile

-- Collect observations first; choose constraints afterwards.
-- Default: presence/singleton bounds. Exact observed extrema are opt-in.
data CountPolicy = PresenceAndSingleton | ObservedExtrema | NoCounts
data Policy = Policy { countPolicy :: CountPolicy }

-- One value expression applies independently to EACH property value.
-- Several datatype alternatives become sh:or within the property shape.
-- Never put alternatives of entire properties around heterogeneous values.
-- Kind takes a set: SHACL has combined kinds (sh:BlankNodeOrIRI, etc.).
data ValueRule
  = AnyValue
  | Kind (Set NodeKind)
  | Datatype Iri
  | Class Iri
  | AllOf [ValueRule]
  | AnyOf [ValueRule]
  deriving (Eq, Show)
data Bounds = Bounds { lower :: Maybe Natural, upper :: Maybe Natural }
  deriving (Eq, Show)
data PropertyShape = PropertyShape
  { path :: Iri
  , bounds :: Bounds
  , valueRule :: ValueRule
  , evidence :: PropertyProfile
  }
data NodeShape = NodeShape { targetClass :: Iri, properties :: [PropertyShape] }
data Proposal = Proposal { shapes :: [NodeShape], notices :: [Notice] }
data Notice = EmptyTarget Iri | UnclassifiedSubjects Natural | DatatypeUnchecked Iri

-- rdf:type gets no bounds under any policy: multi-typing is common, and
-- maxCount 1 observed on rdf:type rejects any later second type.
-- propose applies this; inferBounds itself does not know the path.
-- For N > 0 and at least one observed value:
-- PresenceAndSingleton: minCount 1 iff H[0]=0; maxCount 1 iff max(keys H)<=1.
-- ObservedExtrema: use min/max keys H, omit zero minimum.
-- Empty populations never create vacuously mandatory properties.
-- Absent histogram entries mean 0; stored frequencies must be positive.
-- Empty and zero-only histograms return Nothing: no observed property to emit.
-- Otherwise NoCounts returns Just (Bounds Nothing Nothing): emit the property
-- with its value rule, but without count constraints.
inferBounds :: CountPolicy -> Histogram -> Maybe Bounds

-- Literal branch: OR of observed datatypes. Resource branch: node kind
-- (IRI, blank node, or both), plus common classes if available.
-- Mixed literal and resource values: OR of the two branches.
-- Reduce commonClasses to the most specific: drop c when another member d
-- is a subclass of c and c is not a subclass of d (keeps subclass cycles).
-- Several common classes are a conjunction: AllOf [Class c1, Class c2, ...].
-- No sh:node recursion, closed shapes, enums, or regex inference in v1.
inferValues :: PropertyProfile -> ValueRule
-- Emit an empty NodeShape and EmptyTarget notice for each selected empty class.
-- Emit UnclassifiedSubjects only when unclassifiedSubjectCount > 0.
-- Emit DatatypeUnchecked once per datatype used by a proposed Datatype rule:
-- inference reads datatype IRIs but does not check literal lexical validity.
propose :: Policy -> Profile -> Proposal

-- Shape naming: the caller supplies a function from class IRI to shape IRI.
-- Default: append "Shape" to the class IRI. Fail when two classes give the
-- same shape IRI, or when a shape IRI already occurs in the source graph.
type ShapeNaming = Iri -> Iri
-- Output graph is explicit and unrelated to source graph selection.
-- The JS implementation uses rdf-ext terms, term sets/maps, and datasets.
-- Use sh:datatype (lowercase t), rdf:langString, and well-formed RDF lists.
-- Stable ordering; output equality is up to blank-node renaming.
-- Every NodeShape gets rdf:type sh:NodeShape and sh:targetClass.
-- Every property gets sh:property linkage and sh:path; emit each present bound.
-- ValueRule mapping at the property/value shape node:
--   AnyValue   -> no value constraint
--   Kind ks    -> sh:nodeKind of the matching SHACL kind:
--                 {IRI} sh:IRI, {Blank} sh:BlankNode, {Literal} sh:Literal,
--                 {IRI,Blank} sh:BlankNodeOrIRI, {IRI,Literal} sh:IRIOrLiteral,
--                 {Blank,Literal} sh:BlankNodeOrLiteral; all three -> none
--   Datatype d -> sh:datatype d
--   Class c    -> sh:class c
--   AllOf rs   -> if no member is AllOf/AnyOf: all constraints on the same
--                 node (constraints of one shape are conjunctive; several
--                 sh:class values are valid). Otherwise sh:and RDF list.
--                 Never two sh:datatype values on one node (SHACL allows one).
--   AnyOf rs   -> sh:or RDF list of fresh shapes, one per rule
-- Normalize singleton combinations to their member. Empty combinations are
-- prohibited in proposals; use AnyValue for an unconstrained value instead.
-- Allocate fresh shape/list nodes distinct from input nodes. Evidence stays
-- in the returned proposal; emit does not invent an RDF evidence vocabulary.
emit :: ShapeNaming -> Graph -> Proposal -> Dataset

-- Endpoint adapter: build the same Profile with SPARQL aggregate queries,
-- then reuse propose and emit. Only aggregates cross the network.
-- Graph scope: OneGraph DefaultGraph queries the endpoint default graph as
-- configured (it can be a union of all graphs, or include inference);
-- NamedGraph and UnionGraphs use FROM clauses; a union with the default graph
-- cannot be expressed with FROM and is rejected. Report, do not guess,
-- the endpoint's default-graph and entailment semantics.
-- Per target class C (membership: ?s rdf:type/rdfs:subClassOf* C, in scope):
--   population:  COUNT(DISTINCT ?s)
--   histogram:   per ?p, GROUP BY ?k over (?s, COUNT(DISTINCT ?o) AS ?k)
--   kinds and datatypes: DISTINCT isIRI/isBlank/isLiteral, DATATYPE(?o)
--   untypedResources: resource values without any rdf:type in scope
--   commonClasses: class D is common iff the count of distinct resource
--                  values in D equals the count of distinct resource values
-- Completeness: fail on HTTP errors and timeouts. Endpoints can truncate
-- results without an error, so every multi-row query is checked against a
-- one-row COUNT(*) of the same query, and the nonzero histogram entries
-- must not exceed the population. A mismatch is an error, not a partial result.
-- Limit: an endpoint that truncates silently inside a one-row aggregate
-- (partial "anytime" results) cannot be detected.
-- Equivalence law: for the same stable graph and scope semantics,
-- profileEndpoint and profile . index give the same Profile.
type EndpointUrl = String
data EndpointError = QueryFailed String | Incomplete Iri Iri
profileEndpoint :: EndpointUrl -> Scope -> Targets -> IO (Either EndpointError Profile)

-- External validator adapter; no validator dependency in the inference core.
-- Ill-typed source literals can violate inferred datatype constraints.
-- Therefore training-data conformance must be checked, never presumed.
data Validation = Conforms | Violations String | ValidationFailure String
type Validator = ScopedGraph -> Dataset -> IO Validation
data CheckedProposal = CheckedProposal Proposal Validation
check :: Validator -> ShapeNaming -> Graph -> ScopedGraph -> Proposal -> IO CheckedProposal

-- Algorithm:
-- 1. Select graphs and deduplicate triples (local input).
-- 2. Index subject/predicate/value sets, explicit types and subclass closure.
-- 3. Resolve target populations; each multi-typed subject joins each target once.
-- 4. Aggregate nonzero counts and value descriptors for each class/property.
-- 5. Set H[0] = population - sum(nonzero histogram frequencies).
-- 6. Infer independent constraints; emit shapes and retain evidence separately.
-- 7. Validate the proposal against exactly its extraction graph.
--
-- Laws for the future JS implementation:
-- * Input permutation and duplicate quads do not change profiles.
-- * sum(H) = population; no support division when population = 0.
-- * OneGraph g is invariant under additions to any different graph.
-- * Blank-node renaming preserves results up to renaming.
-- * Multi-typing cannot inflate value counts.
-- * Sample support is an observed ratio, not statistical confidence.
-- * Separately passing constraints need not jointly pass a support threshold.
--
-- Complexity: memory O(T + expanded memberships + profile size), where T is
-- selected distinct triples. Profiling work includes each triple's target
-- memberships and each object's class set; it is not simply O(T) for arbitrary
-- multi-typing. Subclass closure adds its own graph traversal/storage cost.
-- Arbitrary-order async input needs materialization, replay, or external storage.
-- Do not advertise bounded-memory streaming for this contract.

manifestOnly :: a
manifestOnly = error "signature-level specification only"

selectGraphs = manifestOnly
index = manifestOnly
profile = manifestOnly
inferBounds = manifestOnly
inferValues = manifestOnly
propose = manifestOnly
emit = manifestOnly
check = manifestOnly
profileEndpoint = manifestOnly
