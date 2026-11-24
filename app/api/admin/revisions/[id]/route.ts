import { NextResponse } from 'next/server';
import { Types } from 'mongoose';
import connectToDatabase from '@/lib/mongodb';
import Revision from '@/models/Revision';
import { withAdmin } from '@/lib/http/admin-handler';
import { notFound, validationError } from '@/lib/http/errors';
import { logAudit } from '@/lib/audit/logger';

// Direct Next.js dynamic rendering.
export const dynamic = 'force-dynamic';

// GET /api/admin/revisions/:id
// Fetches the full revision detail including the deep content snapshot payload for comparison/diff views.
// Security & Tenancy:
// - Verifies the revision belongs to siteId of the authenticated admin context.
// - Returns 404 if revision does not exist or belongs to an unauthorized tenant site.
export const GET = withAdmin<{ id: string }>(
  async (_req, { params, site }) => {
    // Await route segment parameter in accordance with Next.js dynamic routing.
    const { id } = await params;

    // Validate ObjectId syntax before querying database.
    if (!Types.ObjectId.isValid(id)) {
      throw validationError({ id: ['Invalid revision id'] });
    }

    await connectToDatabase();

    // Query revision by primary key scoped strictly by siteId.
    const revision = await Revision.findOne({
      _id: new Types.ObjectId(id),
      siteId: new Types.ObjectId(site.id),
    }).exec();

    if (!revision) {
      throw notFound('Revision');
    }

    return NextResponse.json(revision);
  },
  { site: true },
);
