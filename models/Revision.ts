import mongoose, { Document, Model, Schema, Types } from 'mongoose';
import type { IBlog } from '@/models/Blog';
import type { IEvent } from '@/models/Event';

// Purpose: Define a custom name (BlogRevisionSnapshot) for a type definition without generating any JavaScript code at runtime. It exists purely at compile time for static type checking.
// Omit: A standard TypeScript built-in utility type defined as Omit<T, K>. Omit constructs a new type by taking all properties from type T (IBlog) and dropping (excluding) the keys specified in K (the union of document and metadata keys). 
// keyof: Takes an object type (in this case Document) and extracts all of its known property and method names as a string literal union. Example: If an interface has { id: string; save(): void }, keyof evaluates to 'id' | 'save'.
// | (Union Operator): Logical "OR" for types.
// Document: The base interface provided by Mongoose. Represents the MongoDB document prototype containing internal methods and fields like _id, __v, save(), isModified(), $set(), etc.
export type BlogRevisionSnapshot = Omit<
  IBlog,
  keyof Document | 'siteId' | 'createdAt' | 'updatedAt' | 'createdBy' | 'updatedBy'
>;

// Similar type created for Event entity
export type EventRevisionSnapshot = Omit<
  IEvent,
  keyof Document | 'siteId' | 'createdAt' | 'updatedAt' | 'createdBy' | 'updatedBy'
>;

// Types of entities handled by the revisions model at this point in time. Can be extended for other entities in the future.
export type RevisionEntityType = 'blog' | 'event';

// Actions that trigger a revision. 
export type RevisionTrigger = 'create' | 'update' | 'publish' | 'unpublish' | 'restore';

// Final Revision Snapshot type exported for use by other models and services. Union can be extended for other entities in the future.
export type RevisionSnapshot = BlogRevisionSnapshot | EventRevisionSnapshot;

// Interface for storing author/ creator information.
export interface IRevisionAuthor {
  id: Types.ObjectId;
  name: string;
  email: string;
}

// Final Revision Interface exported for use by other models and services. 
export interface IRevision extends Document<Types.ObjectId> {
  siteId: Types.ObjectId;
  entityType: RevisionEntityType;
  entityId: Types.ObjectId;
  majorVersion: number;
  minorVersion: number;
  version: string;
  restoredFromVersion?: string | null;
  trigger: RevisionTrigger;
  author: IRevisionAuthor;
  snapshot: RevisionSnapshot;
  summary?: string;
  createdAt: Date;
}

// Mongoose Schema for author information based on the IRevisionAuthor interface. 
const RevisionAuthorSchema = new Schema<IRevisionAuthor>(
  {
    id: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    email: { type: String, required: true },
  },
  // Making sure a new separate _id is not created for each revision author. Intended as a dependent object in the sense that its lifecycle is tied to the parent revision document.
  { _id: false },
);

// Mongoose Schema for revision based on the IRevision interface. 
const RevisionSchema = new Schema<IRevision>(
  {
    siteId: { type: Schema.Types.ObjectId, ref: 'Site', required: true, index: true },
    entityType: { type: String, enum: ['blog', 'event'], required: true, index: true },
    entityId: { type: Schema.Types.ObjectId, required: true, index: true },
    majorVersion: { type: Number, required: true, default: 1 },
    minorVersion: { type: Number, required: true, default: 0 },
    version: { type: String, required: true },
    restoredFromVersion: { type: String, default: null },
    trigger: {
      type: String,
      enum: ['create', 'update', 'publish', 'unpublish', 'restore'],
      default: 'update',
      index: true,
    },
    author: { type: RevisionAuthorSchema, required: true },
    snapshot: { type: Schema.Types.Mixed, required: true },
    summary: { type: String, default: '' },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'revisions',
  },
);
+
// Indexing for efficient querying of revisions. Group revisions by site id, entity type, and entity id, ordered by version.
// The compound unique index guarantees revision version uniqueness scoped per entityType, preventing collisions if blog and event IDs overlap.
RevisionSchema.index(
  { siteId: 1, entityType: 1, entityId: 1, majorVersion: -1, minorVersion: -1 },
  { unique: true },
);

// If we update the schema (for example, adding new fields), Next.js re-evaluates the file, but Mongoose keeps using the old compiled schema from memory. It refuses to recompile and will not recognize the new schema fields or validation rules.
// The solution: This snippet forcibly clears the cached model from Mongoose's internal registry before re-registering it, ensuring Mongoose always compiles against the latest schema definitions.
if (mongoose.models && mongoose.models.Revision) {
  delete (mongoose.models as Record<string, unknown>).Revision;
}

// Compiling the model using the schema and exporting it.
const Revision: Model<IRevision> = mongoose.model<IRevision>('Revision', RevisionSchema);

export default Revision;
