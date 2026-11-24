import { NextResponse } from 'next/server';
import { Types } from 'mongoose';
import connectToDatabase from '@/lib/mongodb';
import Revision, { type RevisionEntityType } from '@/models/Revision';
import { withAdmin } from '@/lib/http/admin-handler';
import { validationError } from '@/lib/http/errors';

// Instruct Next.js route engine to execute dynamically on every request without caching.
export const dynamic = 'force-dynamic';

// GET /api/admin/revisions
// Lists revision history summaries for a specific entity scoped strictly to the caller's active tenant site.
// Architecture & Security:
// - withAdmin({ site: true }): Validates session authentication, verifies caller has access to the site,
//   and resolves the active tenant Site model instance.
// - Strict site isolation: Queries siteId directly from the server-resolved session (site.id);
//   prevents horizontal privilege escalation across different tenant sites.
// - Selective projection: Returns only metadata fields (_id, version, author, timestamp, trigger);
//   omits bulky snapshot payloads to keep listing responses ultra-fast and lightweight.
export const GET = withAdmin(
  async (req, { site }) => {
    // Parse query parameters from request URL.
    const searchParams = req.nextUrl.searchParams;
    const entityType = searchParams.get('entityType') as RevisionEntityType;
    const entityId = searchParams.get('entityId');
    const trigger = searchParams.get('trigger');

    // Input Validation: Ensure entityType is an allowed domain model ('blog' or 'event').
    if (!entityType || !['blog', 'event'].includes(entityType)) {
      throw validationError({ entityType: ['Valid entityType (blog | event) is required'] });
    }

    // Input Validation: Ensure entityId is a syntactically valid MongoDB 24-character hex ObjectId.
    if (!entityId || !Types.ObjectId.isValid(entityId)) {
      throw validationError({ entityId: ['Valid entityId is required'] });
    }

    // Connect to database instance via singleton connection pool.
    await connectToDatabase();

    // Construct tenant-scoped query boundary.
    const query: Record<string, unknown> = {
      siteId: new Types.ObjectId(site.id),
      entityType,
      entityId: new Types.ObjectId(entityId),
    };

    // Optional trigger filter (e.g., fetch only publish milestones).
    if (trigger) {
      query.trigger = trigger;
    }

    // Query Bounds & Pagination:
    // Limit defaults to 100 entries (capped at 500) to ensure bounded memory and network transfer.
    const rawLimit = searchParams.get('limit');
    let limit = 100;
    if (rawLimit !== null) {
      if (!/^\d+$/.test(rawLimit)) {
        throw validationError({ fieldErrors: { limit: ['limit must be a positive integer'] } }, 'Invalid pagination parameters');
      }
      const parsedLimit = Number(rawLimit);
      if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1) {
        throw validationError({ fieldErrors: { limit: ['limit must be a positive integer greater than 0'] } }, 'Invalid pagination parameters');
      }
      limit = Math.min(parsedLimit, 500);
    }

    const rawPage = searchParams.get('page');
    let page = 1;
    if (rawPage !== null) {
      if (!/^\d+$/.test(rawPage)) {
        throw validationError({ fieldErrors: { page: ['page must be a positive integer'] } }, 'Invalid pagination parameters');
      }
      const parsedPage = Number(rawPage);
      if (!Number.isSafeInteger(parsedPage) || parsedPage < 1 || parsedPage > 100000) {
        throw validationError({ fieldErrors: { page: ['page must be a safe integer between 1 and 100,000'] } }, 'Invalid pagination parameters');
      }
      page = parsedPage;
    }

    const skip = (page - 1) * limit;
    if (!Number.isSafeInteger(skip) || skip < 0) {
      throw validationError({ fieldErrors: { page: ['Calculated pagination offset is out of safe range'] } }, 'Invalid pagination parameters');
    }

    // Database Query:
    // Sorts primarily by majorVersion descending, then minorVersion descending, and finally createdAt descending.
    // Guarantees highest release versions (e.g. v2.0, v1.2, v1.1, v1.0) appear at the top.
    const revisions = await Revision.find(
      query,
      {
        _id: 1,
        majorVersion: 1,
        minorVersion: 1,
        version: 1,
        restoredFromVersion: 1,
        trigger: 1,
        author: 1,
        summary: 1,
        createdAt: 1,
      },
    )
      .sort({ majorVersion: -1, minorVersion: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();

    // Return JSON array of revision summary items.
    return NextResponse.json(revisions);
  },
  { site: true },
);
