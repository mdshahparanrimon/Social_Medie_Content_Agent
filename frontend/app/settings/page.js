'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, PLATFORMS } from '@/lib/api';
import { Button, Card, ErrorText, PageHeader } from '@/components/ui';
import { AccentPicker, ModeSwitch } from '@/components/theme';
import { useAuth } from '@/components/auth';

const AI_PROVIDERS = [
  {
    key: 'gemini',
    name: 'Google Gemini',
    badge: 'Free tier',
    help: 'Free key: aistudio.google.com → Get API key.',
    fields: [
      { key: 'gemini_api_key', label: 'API key', secret: true },
      { key: 'gemini_model', label: 'Model', hint: 'e.g. gemini-2.5-flash. If Test says the model is not found, use the current Flash model name from AI Studio.' },
      { key: 'gemini_fallback_model', label: 'Fallback model', hint: 'Used automatically when the main model is overloaded (503). Set it to the same name as the main model to turn this off.' },
    ],
  },
  {
    key: 'openai_compat',
    name: 'Groq / OpenRouter / Ollama',
    badge: 'Free tier',
    help: 'Any OpenAI-compatible API. Groq: free key at console.groq.com. OpenRouter: base URL https://openrouter.ai/api/v1 with a ":free" model. Ollama on this computer: http://localhost:11434/v1, no key.',
    fields: [
      { key: 'openai_compat_base_url', label: 'Base URL' },
      { key: 'openai_compat_api_key', label: 'API key', secret: true },
      { key: 'openai_compat_model', label: 'Model', hint: 'Groq e.g. llama-3.3-70b-versatile' },
    ],
  },
  {
    key: 'anthropic',
    name: 'Claude (Anthropic)',
    badge: 'Paid, best quality',
    help: 'Key: console.anthropic.com → API keys.',
    fields: [
      { key: 'anthropic_api_key', label: 'API key', secret: true },
      { key: 'anthropic_model', label: 'Model', hint: 'claude-opus-5-5 (best) or claude-sonnet-5-5 (half the price)' },
    ],
  },
];

// Developer apps, set up once per platform. After that, Connections is one click.
const PLATFORM_APPS = [
  {
    key: 'x',
    title: 'X app',
    steps: [
      'console.x.com → your app → User authentication settings → Set up (or Edit).',
      'App permissions: "Read and write". Type: Web App, Automated App or Bot.',
      'Callback URI: paste the Callback URL below. Website URL: any site of yours. Save.',
      'Keys & Tokens → OAuth 1.0 Keys: copy the Consumer Key and Consumer Secret here.',
    ],
    fields: [
      { key: 'x_api_key', label: 'Consumer Key', secret: true },
      { key: 'x_api_secret', label: 'Consumer Secret', secret: true },
    ],
  },
  {
    key: 'linkedin',
    title: 'LinkedIn app',
    steps: [
      'developer.linkedin.com → Create app. It asks for a Company Page only to register the app; posts go to your own profile.',
      'Products tab: request "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect" (both are instant).',
      'Auth tab → Authorized redirect URLs: add the Callback URL below.',
      'Auth tab: copy the Client ID and Client Secret here.',
    ],
    fields: [
      { key: 'linkedin_client_id', label: 'Client ID' },
      { key: 'linkedin_client_secret', label: 'Client Secret', secret: true },
      { key: 'linkedin_api_version', label: 'API version (YYYYMM)', hint: 'Change only if LinkedIn says the version is not supported.' },
    ],
  },
  {
    key: 'meta',
    title: 'Facebook app',
    steps: [
      'developers.facebook.com → My Apps → Create app → use case "Manage everything on your Page".',
      'Use cases → Customize → add the permissions pages_show_list, pages_manage_posts, pages_read_engagement.',
      'Facebook Login → Settings → Valid OAuth Redirect URIs: add the Callback URL below.',
      'App settings → Basic: copy the App ID and App Secret here. In development mode it works for your own account without review.',
    ],
    fields: [
      { key: 'meta_app_id', label: 'App ID' },
      { key: 'meta_app_secret', label: 'App Secret', secret: true },
      { key: 'meta_graph_version', label: 'Graph API version', hint: 'e.g. v23.0' },
    ],
  },
  {
    key: 'instagram',
    title: 'Instagram app',
    steps: [
      'In the Instagram app on your phone: Settings → Account type → switch to a Professional account (Creator or Business). Free.',
      'developers.facebook.com → your app (or a new one) → add the use case "Manage messaging & content on Instagram" → API setup with Instagram login.',
      'Set up Instagram business login → Business login settings → OAuth redirect URIs: add the Callback URL below.',
      'App roles → Roles → add your Instagram account as an Instagram Tester, then accept the invite in Instagram (Settings → Website permissions → Tester invites).',
      'Copy the Instagram App ID and Instagram App Secret (not the Facebook ones) here.',
    ],
    fields: [
      { key: 'instagram_app_id', label: 'Instagram App ID' },
      { key: 'instagram_app_secret', label: 'Instagram App Secret', secret: true },
    ],
  },
];

function FieldInput({ field, stored, value, onChange }) {
  if (field.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={Boolean(value ?? stored)} onChange={(e) => onChange(e.target.checked)} />
        {field.label}
      </label>
    );
  }

  if (field.secret) {
    const removing = value === null;
    const placeholder = removing
      ? 'Will be removed when you save'
      : stored?.set
        ? `Saved (${stored.hint}). Type to replace.`
        : 'Not set';
    return (
      <div>
        <label className="label">{field.label}</label>
        <div className="flex gap-2">
          <input
            type="password"
            autoComplete="off"
            className="input"
            value={typeof value === 'string' ? value : ''}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
          {stored?.set && !removing && (
            <Button variant="ghost" onClick={() => onChange(null)}>
              Remove
            </Button>
          )}
        </div>
        {field.hint && <p className="hint">{field.hint}</p>}
      </div>
    );
  }

  return (
    <div>
      <label className="label">{field.label}</label>
      <input
        type={field.type === 'time' ? 'time' : 'text'}
        className={`input ${field.type === 'time' ? 'w-36' : ''}`}
        value={value ?? stored ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
      {field.hint && <p className="hint">{field.hint}</p>}
    </div>
  );
}

// A card with its own unsaved edits, a Save button and an optional connection test.
function Section({ id, title, badge, description, settings, onSaved, testTarget, children }) {
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const dirty = Object.keys(draft).length > 0;

  const setField = (key, value) => {
    setResult(null);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  async function run(kind) {
    setBusy(kind);
    setResult(null);
    try {
      if (dirty) {
        onSaved(await api('/settings', { method: 'PUT', body: draft }));
        setDraft({});
      }
      if (kind === 'test') {
        setResult(await api(`/settings/test/${testTarget}`, { method: 'POST' }));
      } else {
        setResult({ ok: true, message: 'Saved' });
      }
    } catch (err) {
      setResult({ ok: false, message: err.message });
    }
    setBusy(null);
  }

  const field = (def) => (
    <FieldInput
      key={def.key}
      field={def}
      stored={settings[def.key]}
      value={draft[def.key]}
      onChange={(value) => setField(def.key, value)}
    />
  );

  return (
    <Card className="scroll-mt-6 space-y-4">
      <div id={id}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">{title}</h2>
          {badge}
        </div>
        {description && <p className="hint">{description}</p>}
      </div>
      {children({ field, draft, setField })}
      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3">
        <Button onClick={() => run('save')} disabled={!dirty || busy !== null}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </Button>
        {testTarget && (
          <Button variant="secondary" onClick={() => run('test')} disabled={busy !== null}>
            {busy === 'test' ? 'Testing…' : dirty ? 'Save & test' : 'Test connection'}
          </Button>
        )}
        {result && (
          <span className={`text-sm ${result.ok ? 'text-emerald-700' : 'text-red-600'}`}>{result.message}</span>
        )}
      </div>
    </Card>
  );
}

function ReadyBadge({ ready }) {
  return ready ? (
    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">App ready</span>
  ) : (
    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">Not set up</span>
  );
}

function CallbackUrl({ url }) {
  const [copied, setCopied] = useState(false);
  if (!url) return null;
  return (
    <div>
      <label className="label">Callback URL (paste into the developer app)</label>
      <div className="flex gap-2">
        <code className="input select-all overflow-x-auto bg-zinc-50 whitespace-nowrap">{url}</code>
        <Button
          variant="secondary"
          onClick={() => {
            navigator.clipboard?.writeText(url);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { isAdmin } = useAuth();
  const [settings, setSettings] = useState(null);
  const [login, setLogin] = useState(null);
  const [status, setStatus] = useState(null);
  const [apps, setApps] = useState({});
  const [error, setError] = useState('');

  const loadStatus = useCallback(() => {
    api('/status').then(setStatus).catch(() => {});
    api('/oauth/info').then(setApps).catch(() => {});
    api('/auth/providers').then(setLogin).catch(() => {});
  }, []);

  useEffect(() => {
    api('/settings')
      .then(setSettings)
      .catch((err) => setError(err.message));
    loadStatus();
  }, [loadStatus]);

  // Jump to a platform's setup when linked from Connections (e.g. /settings#instagram).
  useEffect(() => {
    if (settings && window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, [settings]);

  const onSaved = (updated) => {
    setSettings(updated);
    loadStatus();
  };

  if (!settings) return error ? <ErrorText error={error} /> : <p className="text-sm text-zinc-500">Loading…</p>;

  const mediaReady = settings.cloudinary_cloud_name && settings.cloudinary_api_key && settings.cloudinary_api_secret?.set;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description={
          isAdmin
            ? 'App-wide settings apply to every user; Publishing is your own workspace. API keys are stored encrypted and never shown again.'
            : 'Settings for your workspace.'
        }
      />

      {isAdmin && (
        <>

      <Section
        id="ai"
        title="AI"
        description="Pick which AI writes your content. Use a free one for testing and switch any time."
        settings={settings}
        onSaved={onSaved}
        testTarget="ai"
      >
        {({ field, draft, setField }) => {
          const providerKey = draft.ai_provider ?? settings.ai_provider;
          const provider = AI_PROVIDERS.find((p) => p.key === providerKey);
          return (
            <>
              <div className="grid gap-2 sm:grid-cols-3">
                {AI_PROVIDERS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setField('ai_provider', p.key)}
                    className={`rounded-lg border p-3 text-left ${
                      p.key === providerKey ? 'border-accent-500 bg-accent-50' : 'border-zinc-200 hover:border-zinc-300'
                    }`}
                  >
                    <div className="text-sm font-medium">{p.name}</div>
                    <div className="text-xs text-zinc-500">{p.badge}</div>
                  </button>
                ))}
              </div>
              <p className="hint">{provider.help}</p>
              <div className="space-y-3">{provider.fields.map(field)}</div>
            </>
          );
        }}
      </Section>

      <Section
        id="signin"
        title="Sign-in & email"
        badge={<ReadyBadge ready={login?.email_delivery} />}
        description="How customers create accounts and sign in. Without a Resend key, verification and password-reset links are only printed in the backend terminal."
        settings={settings}
        onSaved={onSaved}
      >
        {({ field }) => (
          <>
            {field({ key: 'allow_signups', label: 'Allow new sign-ups (turn off to make the app invite-only)', type: 'boolean' })}
            <div className="space-y-3 rounded-lg border border-zinc-200 p-4">
              <h3 className="text-sm font-semibold text-zinc-900">Email (Resend)</h3>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-600">
                <li>Create a free account at resend.com → API Keys → Create API key.</li>
                <li>Domains → add your domain and its DNS records, so emails come from your own address.</li>
                <li>Until then, the sender onboarding@resend.dev can only send to your own Resend email.</li>
              </ol>
              <div className="grid gap-3 sm:grid-cols-2">
                {field({ key: 'resend_api_key', label: 'Resend API key', secret: true })}
                {field({ key: 'email_from', label: 'From address', hint: 'e.g. Content Agent <hello@yourdomain.com>' })}
              </div>
            </div>
            <div className="space-y-3 rounded-lg border border-zinc-200 p-4">
              <h3 className="text-sm font-semibold text-zinc-900">Continue with Google</h3>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-600">
                <li>console.cloud.google.com → APIs &amp; Services → OAuth consent screen: set it up (External).</li>
                <li>Credentials → Create credentials → OAuth client ID → Web application.</li>
                <li>Authorized redirect URIs: paste the Callback URL below. Copy the Client ID and Secret here.</li>
              </ol>
              <CallbackUrl url={login?.callback_urls?.google} />
              <div className="grid gap-3 sm:grid-cols-2">
                {field({ key: 'google_client_id', label: 'Client ID' })}
                {field({ key: 'google_client_secret', label: 'Client Secret', secret: true })}
              </div>
            </div>
            <div className="space-y-3 rounded-lg border border-zinc-200 p-4">
              <h3 className="text-sm font-semibold text-zinc-900">Continue with LinkedIn</h3>
              <p className="text-sm text-zinc-600">
                Uses the LinkedIn app below. In its Auth tab, add this second redirect URL (the one below is for posting). It turns on
                once the LinkedIn Client ID and Secret are saved.
              </p>
              <CallbackUrl url={login?.callback_urls?.linkedin} />
            </div>
          </>
        )}
      </Section>

      <div>
        <h2 className="text-lg font-semibold">Platform apps</h2>
        <p className="text-sm text-zinc-500">
          One-time setup per platform (about 10 minutes each). After that, connect your accounts with one click on the{' '}
          <Link href="/connections" className="text-accent-600 hover:underline">
            Connections
          </Link>{' '}
          page.
        </p>
      </div>

      {PLATFORM_APPS.map((app) => (
        <Section
          key={app.key}
          id={app.key}
          title={app.title}
          badge={<ReadyBadge ready={apps[app.key]?.app_ready} />}
          settings={settings}
          onSaved={onSaved}
        >
          {({ field }) => (
            <details open={!apps[app.key]?.app_ready} className="space-y-3">
              <summary className="cursor-pointer text-sm font-medium text-zinc-700">Setup steps</summary>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-zinc-600">
                {app.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <CallbackUrl url={apps[app.key]?.callback_url} />
              <div className="grid gap-3 sm:grid-cols-2">{app.fields.map(field)}</div>
            </details>
          )}
        </Section>
      ))}

      <Section
        id="media"
        title="Media (image hosting)"
        badge={<ReadyBadge ready={mediaReady} />}
        description="Instagram and Facebook download post images from a public link, which this computer can't provide. Cloudinary hosts your images for free. Without it, uploaded images stay on this computer and only work once the app runs on a server with a public address."
        settings={settings}
        onSaved={onSaved}
      >
        {({ field }) => (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-600">
              <li>Create a free account at cloudinary.com.</li>
              <li>Dashboard → API Keys (Settings → API Keys): copy the Cloud name, API Key and API Secret here.</li>
            </ol>
            <div className="grid gap-3 sm:grid-cols-3">
              {field({ key: 'cloudinary_cloud_name', label: 'Cloud name' })}
              {field({ key: 'cloudinary_api_key', label: 'API Key' })}
              {field({ key: 'cloudinary_api_secret', label: 'API Secret', secret: true })}
            </div>
          </>
        )}
      </Section>

        </>
      )}

      <Section
        id="publishing"
        title="Publishing"
        description="Default posting times are used when you approve a post without picking a time (this computer's timezone)."
        settings={settings}
        onSaved={onSaved}
      >
        {({ field }) => (
          <>
            {field({ key: 'dry_run', label: 'Dry run: simulate every post, even on connected accounts', type: 'boolean' })}
            <div className="flex flex-wrap gap-4">
              {Object.entries(PLATFORMS).map(([key, p]) => field({ key: `post_time_${key}`, label: p.label, type: 'time' }))}
            </div>
          </>
        )}
      </Section>

      <Card className="space-y-4">
        <div>
          <h2 className="font-semibold">Appearance</h2>
          <p className="text-sm text-zinc-500">Saved in this browser. System follows your device&apos;s light/dark setting.</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-10 gap-y-4">
          <div>
            <span className="label">Theme</span>
            <ModeSwitch showLabels />
          </div>
          <div>
            <span className="label">Accent color</span>
            <AccentPicker />
          </div>
        </div>
      </Card>

      {status && (
        <Card className="space-y-1 text-sm">
          <h2 className="mb-2 font-semibold">AI usage</h2>
          <p>
            Active: {status.ai.label} ({status.ai.model})
          </p>
          <p>Calls: {status.usage.calls}</p>
          <p>
            Tokens: {status.usage.input_tokens.toLocaleString()} in / {status.usage.output_tokens.toLocaleString()} out
          </p>
          <p>Claude cost (estimated): ${status.usage.cost_usd.toFixed(2)}</p>
        </Card>
      )}
    </div>
  );
}
