import { z } from 'zod';
import { rulesFor } from './mediaRules.js';
import { PLATFORMS } from './platforms.js';

// A structured brief for a short video: what it is for, what happens scene by scene, and what text/voice goes with it.
//
// What the app can do with it today:
//  - The visual parts (hook, scenes' visuals, visual direction, branding colours, duration/aspect) become the prompt for
//    the workspace's AI video model, which makes a short clip with no readable text and no sound control.
//  - Narration, on-screen text, captions and the CTA are kept with the post as a production spec. The video models
//    can't render them reliably, so they have to be added in an editor. briefLimits() lists exactly which parts those are.
//  - A finished video from elsewhere (Drive link) is checked against the platform's limits; the brief is optional there.

export const VideoBriefZ = z.object({
  objective: z.string().min(5).max(300).describe('What the video should achieve for the brand'),
  audience: z.string().min(3).max(300),
  hook: z.string().min(5).max(300).describe('The first 1-3 seconds: what the viewer sees/hears that stops the scroll'),
  scenes: z
    .array(
      z.object({
        visual: z.string().min(5).max(500).describe('What is on screen'),
        seconds: z.number().min(0.5).max(60),
        narration: z.string().max(400).optional(),
        on_screen_text: z.string().max(120).optional(),
      }),
    )
    .min(1)
    .max(12),
  narration: z.string().max(1500).optional().describe('Full voice-over script, if any'),
  captions: z.string().max(1500).optional().describe('Subtitle text, if different from the narration'),
  visual_direction: z.string().max(600).optional().describe('Look and feel: camera, lighting, palette, pace'),
  duration_seconds: z.number().min(2).max(180).optional().describe('Target length'),
  aspect: z.enum(['16:9', '9:16']).optional(),
  branding: z.string().max(300).optional().describe('Logo placement, colours, end card'),
  cta: z.string().max(200).optional(),
});

/** Problems a person should hear about before a video is made or published. {errors, warnings}. */
export function checkBrief(brief, platform) {
  const errors = [];
  const warnings = [];
  const total = brief.scenes.reduce((s, x) => s + x.seconds, 0);
  const rules = rulesFor('video', platform);
  const target = brief.duration_seconds ?? total;
  if (brief.duration_seconds && Math.abs(total - brief.duration_seconds) > Math.max(2, brief.duration_seconds * 0.15)) {
    warnings.push(`The scenes add up to ${total.toFixed(0)} s but the target is ${brief.duration_seconds} s.`);
  }
  if (rules) {
    if (target < rules.minSeconds) errors.push(`${target.toFixed(0)} s is shorter than ${PLATFORMS[platform].label} accepts (${rules.minSeconds} s).`);
    if (target > rules.maxSeconds) errors.push(`${target.toFixed(0)} s is longer than ${PLATFORMS[platform].label} accepts (${rules.maxSeconds} s).`);
  }
  if (!brief.cta) warnings.push('No call to action in the brief.');
  if (brief.scenes[0] && !/\S/.test(brief.hook)) errors.push('The hook is empty.');
  const spoken = [brief.narration, ...brief.scenes.map((s) => s.narration)].filter(Boolean).join(' ');
  if (spoken && !brief.captions) warnings.push('There is narration but no caption text. Most people watch muted; add captions.');
  const wantsAspect = PLATFORMS[platform]?.video.aspect;
  if (brief.aspect && wantsAspect && brief.aspect !== wantsAspect) warnings.push(`${PLATFORMS[platform].label} videos are usually ${wantsAspect}; the brief asks for ${brief.aspect}.`);
  return { errors, warnings };
}

/** Which parts of the brief the AI video model can not produce (so a person adds them after). */
export function briefLimits(brief) {
  const manual = [];
  if (brief.narration || brief.scenes.some((s) => s.narration)) manual.push('narration / voice-over');
  if (brief.scenes.some((s) => s.on_screen_text)) manual.push('on-screen text');
  if (brief.captions) manual.push('captions / subtitles');
  if (brief.cta) manual.push('call-to-action end card');
  if (brief.branding) manual.push('logo and brand overlays');
  return manual;
}

/** The prompt for the AI video model: visuals only, in scene order. */
export function briefToPrompt(brief, { aspect, brandName } = {}) {
  const lines = [
    `A ${aspect || brief.aspect || '9:16'} short social video${brandName ? ` for ${brandName}` : ''}.`,
    `Purpose: ${brief.objective}. For: ${brief.audience}.`,
    `Opening (first seconds): ${brief.hook}.`,
    'Scenes, in order:',
    ...brief.scenes.map((s, i) => `${i + 1}. (${s.seconds}s) ${s.visual}`),
    brief.visual_direction && `Look and feel: ${brief.visual_direction}.`,
    'Smooth, deliberate camera movement; clear subject; consistent lighting between scenes.',
    'Do not draw any text, captions, letters, logos or watermarks in the picture; they are added later.',
    'No real people, celebrities or other brands.',
  ];
  return lines.filter(Boolean).join('\n');
}
