-- | Proposed algorithm contract for SHACLxtract, not an implementation.
-- Signature-level specification in the style of rdf-cli/spec/manifest.hs.
-- Input: RDF instance data. Output: candidate SHACL shapes and evidence.
--
-- Read this as a pipeline:
--   selected graph -> index -> per-class observations -> proposed shapes -> RDF
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
-- PerGraph produces separate extraction results, each validated separately.
data Scope = OneGraph Graph | UnionGraphs (Set Graph) | PerGraph
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
selectGraphs :: Scope -> Dataset -> [ScopedGraph]
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
data ValueRule
  = AnyValue
  | Kind NodeKind
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

-- For N > 0 and at least one observed value:
-- PresenceAndSingleton: minCount 1 iff H[0]=0; maxCount 1 iff max(keys H)<=1.
-- ObservedExtrema: use min/max keys H, omit zero minimum.
-- Empty populations never create vacuously mandatory properties.
-- Absent histogram entries mean 0; stored frequencies must be positive.
-- Empty and zero-only histograms return Nothing: no observed property to emit.
-- Otherwise NoCounts returns Just (Bounds Nothing Nothing): emit the property
-- with its value rule, but without count constraints.
inferBounds :: CountPolicy -> Histogram -> Maybe Bounds

-- Literal branch: OR of observed datatypes. Resource branches: node kind,
-- plus common classes if available. Mixed kinds: OR of these branches.
-- AllOf is needed for multiple common classes; multiple sh:class values
-- must not be emitted as an invalid shortcut for conjunction.
-- No sh:node recursion, closed shapes, enums, or regex inference in v1.
inferValues :: PropertyProfile -> ValueRule
-- Emit an empty NodeShape and EmptyTarget notice for each selected empty class.
-- Emit UnclassifiedSubjects only when unclassifiedSubjectCount > 0.
-- Emit DatatypeUnchecked once per datatype used by a proposed Datatype rule:
-- inference reads datatype IRIs but does not check literal lexical validity.
propose :: Policy -> Profile -> Proposal

-- Output graph is explicit and unrelated to source graph selection.
-- JS implementation should accept an RDF/JS DataFactory from the caller.
-- Use sh:datatype (lowercase t), rdf:langString, and well-formed RDF lists.
-- Stable ordering; output equality is up to blank-node renaming.
-- Every NodeShape gets rdf:type sh:NodeShape and sh:targetClass.
-- Every property gets sh:property linkage and sh:path; emit each present bound.
-- ValueRule mapping at the property/value shape node:
--   AnyValue   -> no value constraint
--   Kind k     -> sh:nodeKind sh:IRI / sh:BlankNode / sh:Literal
--   Datatype d -> sh:datatype d
--   Class c    -> sh:class c
--   AllOf rs   -> sh:and RDF list of fresh shapes, one per rule
--   AnyOf rs   -> sh:or  RDF list of fresh shapes, one per rule
-- Normalize singleton combinations to their member. Empty combinations are
-- prohibited in proposals; use AnyValue for an unconstrained value instead.
-- Allocate fresh shape/list nodes distinct from input nodes. Evidence stays
-- in the returned proposal; emit does not invent an RDF evidence vocabulary.
emit :: Graph -> Proposal -> Dataset

-- External validator adapter; no validator dependency in the inference core.
-- Ill-typed source literals can violate inferred datatype constraints.
-- Therefore training-data conformance must be checked, never presumed.
data Validation = Conforms | Violations String | ValidationFailure String
type Validator = ScopedGraph -> Dataset -> IO Validation
data CheckedProposal = CheckedProposal Proposal Validation
check :: Validator -> Graph -> ScopedGraph -> Proposal -> IO CheckedProposal

-- Algorithm:
-- 1. Select graphs and deduplicate triples.
-- 2. Index subject/predicate/value sets, explicit types and subclass closure.
-- 3. Resolve target populations; each multi-typed subject joins each target once.
-- 4. Aggregate nonzero counts and value descriptors for each class/property.
-- 5. Set H[0] = population - sum(nonzero histogram frequencies).
-- 6. Infer independent constraints; emit shapes and retain evidence separately.
-- 7. Validate each proposal against exactly its extraction graph.
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
