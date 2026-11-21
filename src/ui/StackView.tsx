import { lazy } from 'react';
import { useApp, useRoute } from '@/state/store';
import { ErrorBoundary } from './components/ErrorBoundary';

const Detail = lazy(() => import('./screens/Detail').then((m) => ({ default: m.Detail })));
const Guide = lazy(() => import('./screens/Guide').then((m) => ({ default: m.Guide })));
const ChannelPage = lazy(() => import('./screens/Channels').then((m) => ({ default: m.ChannelPage })));
const Grid = lazy(() => import('./screens/Grid').then((m) => ({ default: m.Grid })));
const SettingsSectionView = lazy(() => import('./screens/Settings').then((m) => ({ default: m.SettingsSectionView })));
const SourceEdit = lazy(() => import('./screens/SourceEdit').then((m) => ({ default: m.SourceEdit })));
const ProfilesManage = lazy(() => import('./screens/Profiles').then((m) => ({ default: m.ProfilesManage })));
const ProfileEdit = lazy(() => import('./screens/Profiles').then((m) => ({ default: m.ProfileEdit })));
const PersonPage = lazy(() => import('./screens/Person').then((m) => ({ default: m.PersonPage })));
const EnrollScreen = lazy(() => import('./screens/Enroll').then((m) => ({ default: m.EnrollScreen })));
const SendToTv = lazy(() => import('./screens/Enroll').then((m) => ({ default: m.SendToTv })));

export function StackView() {
  const r = useRoute();
  if (!r) return null;
  const key = JSON.stringify(r);
  return (
    <div className="stack-page" key={key} data-scope>
      <ErrorBoundary onReset={() => useApp.getState().pop()}>
      {(r.name === 'movie' || r.name === 'series') && <Detail kind={r.name} id={r.id} />}
      {r.name === 'guide' && <Guide channelId={r.channelId} />}
      {r.name === 'channel' && <ChannelPage id={r.id} />}
      {r.name === 'grid' && <Grid kind={r.kind} title={r.title} filter={r.filter} />}
      {r.name === 'settings-section' && <SettingsSectionView section={r.section} />}
      {r.name === 'source-edit' && <SourceEdit sourceId={r.sourceId} />}
      {r.name === 'profiles' && <ProfilesManage />}
      {r.name === 'profile-edit' && <ProfileEdit profileId={r.profileId} />}
      {r.name === 'enroll' && <EnrollScreen />}
      {r.name === 'person' && <PersonPage id={r.id} title={r.title} />}
      </ErrorBoundary>
      {r.name === 'send-to-tv' && <SendToTv target={r.target} />}
    </div>
  );
}
