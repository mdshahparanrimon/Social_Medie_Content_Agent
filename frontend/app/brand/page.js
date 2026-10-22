'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, PLATFORMS } from '@/lib/api';
import { Button, Card, ErrorText, PageHeader } from '@/components/ui';

const GOALS = [
  { value: 'awareness', label: 'Awareness: reach new people' },
  { value: 'leads', label: 'Leads: get people to reach out or sign up' },
  { value: 'sales', label: 'Sales: move people toward buying' },
  { value: 'community', label: 'Community: deepen engagement' },
];

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export default function BrandPage() {
  const [brand, setBrand] = useState(null);
  const [pillarsText, setPillarsText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/brand')
      .then((b) => {
        setBrand(b);
        setPillarsText(b.pillars.join('\n'));
      })
      .catch((err) => setError(err.message));
  }, []);

  const set = (key) => (e) => {
    setBrand({ ...brand, [key]: e.target.value });
  };

  const togglePlatform = (key) => {
    const platforms = brand.platforms.includes(key)
      ? brand.platforms.filter((p) => p !== key)
      : [...brand.platforms, key];
    setBrand({ ...brand, platforms });
  };

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const pillars = pillarsText.split('\n').map((p) => p.trim()).filter(Boolean);
      const updated = await api('/brand', { method: 'PUT', body: { ...brand, pillars } });
      setBrand(updated);
      setPillarsText(updated.pillars.join('\n'));
      toast.success('Brand Brain saved');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!brand) return error ? <ErrorText error={error} /> : <p className="text-sm text-zinc-500">Loading…</p>;

  return (
    <form onSubmit={save} className="space-y-6">
      <PageHeader
        title="Brand Brain"
        description="Everything here goes into every AI call, so the content sounds like you. The more specific, the better."
      />

      <Card className="space-y-4">
        <h2 className="font-semibold">Identity</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Brand name">
            <input className="input" value={brand.name} onChange={set('name')} required />
          </Field>
          <Field label="Content language" hint="e.g. English, Bengali, or Bengali-English mix">
            <input className="input" value={brand.language} onChange={set('language')} />
          </Field>
        </div>
        <Field label="What the brand does" hint="One or two sentences: what you offer and what makes you different.">
          <textarea className="input" rows={3} value={brand.description} onChange={set('description')} />
        </Field>
        <Field label="Primary goal">
          <select className="input" value={brand.goal} onChange={set('goal')}>
            {GOALS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </Field>
      </Card>

      <Card className="space-y-4">
        <h2 className="font-semibold">Audience & voice</h2>
        <Field label="Target audience" hint="Who they are, what they struggle with, what they want.">
          <textarea className="input" rows={3} value={brand.audience} onChange={set('audience')} required />
        </Field>
        <Field label="Tone of voice" hint="e.g. friendly expert, direct, no jargon, light humor, never salesy.">
          <textarea className="input" rows={2} value={brand.tone} onChange={set('tone')} required />
        </Field>
        <Field label="Never write about / never do" hint="Off-limit topics, competitors, words you hate, claims you can't make.">
          <textarea className="input" rows={2} value={brand.avoid} onChange={set('avoid')} />
        </Field>
      </Card>

      <Card className="space-y-4">
        <h2 className="font-semibold">Content strategy</h2>
        <Field label="Content pillars" hint="3–5 recurring topics, one per line.">
          <textarea
            className="input"
            rows={5}
            value={pillarsText}
            onChange={(e) => setPillarsText(e.target.value)}
            required
          />
        </Field>
        <Field label="Your best past posts" hint="Paste a few posts that sound most like you. Separate them with a line containing ---">
          <textarea className="input" rows={8} value={brand.sample_posts} onChange={set('sample_posts')} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Platforms">
            <div className="flex flex-wrap gap-4 pt-1">
              {Object.entries(PLATFORMS).map(([key, p]) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={brand.platforms.includes(key)} onChange={() => togglePlatform(key)} />
                  {p.label}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Posts per week, per platform">
            <input
              type="number"
              min={1}
              max={14}
              className="input w-28"
              value={brand.posts_per_week}
              onChange={set('posts_per_week')}
            />
          </Field>
        </div>
      </Card>

      <ErrorText error={error} />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save Brand Brain'}
        </Button>
      </div>
    </form>
  );
}
