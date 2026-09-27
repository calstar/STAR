// Panel API: served outside the school-login gate, authenticated by Onshape OAuth
// (see auth/panel.ts). Read-only catalog + insert; no hub admin actions.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { getPart, listParts } from '../db.ts';
import { onshape } from '../library.ts';
import { OnshapeError } from '../onshape/client.ts';
import { catalogJson } from '../parts.ts';
import { deleteSession, requirePanelSession, SessionExpired, withUserToken } from '../auth/panel.ts';

export const panelApi = Router();
panelApi.use(requirePanelSession);

const ONSHAPE_ID = /^[0-9a-f]{24}$/i;

panelApi.get('/catalog', (_req, res) => {
  res.json(listParts({ onlyReady: true }).map(catalogJson));
});

panelApi.post('/insert', async (req, res) => {
  const { partId, documentId, workspaceId, elementId } = req.body ?? {};
  if (![documentId, workspaceId, elementId].every((id) => ONSHAPE_ID.test(String(id)))) {
    res.status(400).json({ error: 'Open an assembly workspace to insert' });
    return;
  }
  const part = getPart(Number(partId));
  if (!part || part.archived || part.status !== 'ready' || !part.elementId || !part.versionId) {
    res.status(404).json({ error: 'That part is not available' });
    return;
  }
  await withUserToken(req.panelSession!, (token) =>
    onshape().insertPartStudio(
      { kind: 'bearer', token },
      { documentId, workspaceId, elementId },
      { elementId: part.elementId!, versionId: part.versionId! },
    ),
  );
  res.json({ ok: true, name: part.name });
});

panelApi.post('/signout', (req, res) => {
  deleteSession(req.panelSession!);
  res.json({ ok: true });
});

panelApi.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof SessionExpired) {
    res.status(401).json({ error: 'Sign in to Onshape' });
  } else if (err instanceof OnshapeError) {
    console.error('[panel]', err.message);
    const hint =
      err.status === 403 || err.status === 404
        ? 'Onshape refused the insert. Do you have view access to the STAR Parts Library document, and edit access to this assembly?'
        : `Onshape error ${err.status}`;
    res.status(502).json({ error: hint });
  } else {
    console.error('[panel]', err);
    res.status(500).json({ error: 'Server error' });
  }
});
