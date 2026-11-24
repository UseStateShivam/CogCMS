import { NextResponse } from 'next/server';
import { Types } from 'mongoose';
import { withAdmin } from '@/lib/http/admin-handler';
import { validationError } from '@/lib/http/errors';
import { restoreRevision } from '@/lib/revisions/engine';

// Direct dynamic Next.js API execution.
export const dynamic = 'force-dynamic';

// POST /api/admin/revisions/:id/restore
// Restores a past revision snapshot into the document AS A DRAFT (without publishing as a side effect),
// produces a new milestone revision record (v(N+1).0 with trigger 'restore'), and logs the restoration in the audit log.
// Security & Tenancy:
// - Protected by withAdmin({ site: true }) ensuring valid authentication and site access.
// - Delegates execution to restoreRevision engine which enforces siteId boundaries within an atomic transaction.
export const POST = withAdmin<{ id: string }>(
  async (_req, { params, site, user }) => {
    // Resolve dynamic path parameter.
    const { id } = await params;

    // Validate MongoDB ObjectId structure.
    if (!Types.ObjectId.isValid(id)) {
      throw validationError({ id: ['Invalid revision id'] });
    }

    // Execute atomic restoration flow within transaction.
    const result = await restoreRevision(id, site.id, user);

    // Return the newly recorded restore revision milestone and canonical restored entity document.
    return NextResponse.json(result);
  },
  { site: true },
);
