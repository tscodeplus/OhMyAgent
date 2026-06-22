import type { VisionCapabilities } from './vision-bridge-types.js';

// ─── Prompt Construction ───

const NOTE_ANALYSIS_SECTIONS = [
  'image_overview',
  'visible_text',
  'objects_and_layout',
  'charts_or_data',
];

const STRUCTURED_SECTIONS = [
  'image_overview',
  'visible_text',
  'objects_and_layout',
  'charts_or_data',
  'relevance_to_user_request',
  'user_request_answer',
  'evidence',
  'uncertainty',
];

/**
 * Build a prompt for plain-text image analysis (no visual primitives).
 */
export function buildNotePrompt(userRequest: string): string {
  const sections = NOTE_ANALYSIS_SECTIONS.map(s => `### ${formatSectionName(s)}`).join('\n');
  const request = userRequest || 'No specific request';
  return `Analyze the attached image and return a structured note. Use these sections:

${sections}

For each section, provide concise, factual observations. Do not speculate beyond what is visible.
User request for context: "${request}"

Return only the note text, no preamble.`;
}

/**
 * Build a prompt for structured image analysis with visual primitives.
 */
export function buildPrimitivePrompt(
  userRequest: string,
  capabilities: VisionCapabilities,
): string {
  const shape = primitivePromptShape(capabilities);
  const sections = STRUCTURED_SECTIONS.map(s => `"${s}"`).join(', ');
  const request = userRequest || 'No specific request';

  return `Analyze the attached image and return a JSON object with these string fields:
${sections}

${shape}

Rules:
- All coordinate values must be integers in the 0–1000 range.
- Include at most 16 visual primitives. Only include primitives that are clearly visible.
- Provide concise, factual text for each section.
- Do not include text outside the JSON object.

User request for context: "${request}"

Return ONLY the JSON object, no markdown fences, no preamble.`;
}

// ─── Primitive Shape Templates ───

function primitivePromptShape(capabilities: VisionCapabilities): string {
  const boxLabel = primitiveBoxOrderLabel(capabilities);

  switch (capabilities.outputFormat) {
    case 'gemini':
      return `Include a "visual_primitives" array of objects with:
- "box_2d": [ymin, xmin, ymax, xmax] — integer coordinates ${boxLabel}
- "label": short description`;

    case 'qwen':
      return `Include a "visual_primitives" array of objects. Each may include:
- "bbox_2d": [x1, y1, x2, y2] — integer coordinates ${boxLabel}
- "point_2d": [x, y] — integer coordinates
- "label": short description`;

    case 'anchor':
      return `Include a "visual_anchors" array of objects with:
- "center": [x, y] — center point coordinates
- "box": [x1, y1, x2, y2] — integer coordinates ${boxLabel}
- "label": short description`;

    default: // hanako
      return `Include a "visual_primitives" array of objects with:
- "box": [x1, y1, x2, y2] — integer coordinates ${boxLabel}
- "label": short description`;
  }
}

export function primitiveBoxOrderLabel(capabilities: VisionCapabilities): string {
  return capabilities.boxOrder === 'yxyx'
    ? '[ymin, xmin, ymax, xmax]'
    : '[x1, y1, x2, y2]';
}

// ─── Formatting ───

function formatSectionName(key: string): string {
  const map: Record<string, string> = {
    image_overview: 'Image Overview',
    visible_text: 'Visible Text',
    objects_and_layout: 'Objects & Layout',
    charts_or_data: 'Charts / Data',
    relevance_to_user_request: 'Relevance to User Request',
    user_request_answer: 'Answer to User Request',
    evidence: 'Evidence',
    uncertainty: 'Uncertainty',
  };
  return map[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function formatSectionNamePublic(key: string): string {
  return formatSectionName(key);
}
