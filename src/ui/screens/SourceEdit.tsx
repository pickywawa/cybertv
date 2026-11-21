import { useEffect, useState } from 'react';
import { db } from '@/core/db';
import { t } from '@/core/i18n';
import { saveSource } from '@/core/profiles';
import { secureGet, sourcePassKey } from '@/core/secure';
import { useApp } from '@/state/store';
import { runSync } from '@/app/services';
import { PageHeader } from '../components/BackButton';
import { SourceForm, draftFromSource, draftValid, emptyDraft, type SourceDraft } from '../components/SourceForm';

export function SourceEdit({ sourceId }: { sourceId?: string }) {
  const profile = useApp((s) => s.profile)!;
  const pop = useApp((s) => s.pop);
  const [draft, setDraft] = useState<SourceDraft | null>(sourceId ? null : emptyDraft());
  useEffect(() => {
    if (!sourceId) return;
    void (async () => {
      const s = await db.sources.get(sourceId);
      if (s) setDraft(draftFromSource(s, (await secureGet(sourcePassKey(s.id))) || ''));
    })();
  }, [sourceId]);
  if (!draft) return null;
  const save = async () => {
    await saveSource(
      profile.id,
      { type: draft.type, label: draft.label, url: draft.url, username: draft.username, password: draft.password, epgUrls: draft.epg.split(/\s+/).filter(Boolean) },
      sourceId,
    );
    pop();
    void runSync(profile.id);
  };
  return (
    <div className="settings">
      <PageHeader title={sourceId ? t('common.edit') : t('settings.addSource')} />
      <div style={{ marginTop: 16 }}>
        <SourceForm draft={draft} onChange={setDraft} />
        <div className="btn-row" style={{ marginTop: 18 }}>
          <button className="btn ghost" data-f onClick={() => pop()}>{t('common.cancel')}</button>
          <button className="btn primary" data-f disabled={!draftValid(draft)} onClick={() => void save()}>{t('common.save')}</button>
        </div>
      </div>
    </div>
  );
}
