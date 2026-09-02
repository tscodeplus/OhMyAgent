/**
 * Feishu card JSON 2.0 building helpers.
 *
 * The standalone interactive cards (approval, harness proposal, user
 * question) are built as JSON 2.0 — the same schema the streaming cards in
 * cardkit-builder.ts already use. 2.0 differences from 1.0 that matter here:
 *   - card content lives under `body.elements`, plus `schema: '2.0'`;
 *   - `div`/lark_md becomes the `markdown` component;
 *   - the 1.0 `action` container is dropped — buttons go directly into
 *     elements (vertical) or inside `column_set` rows (horizontal);
 *   - form submit buttons use `form_action_type: 'submit'`;
 *   - header `template` colors keep the same enum as 1.0.
 */

/** JSON 2.0 card skeleton. */
export function buildCard20(
  headerTitle: string,
  template: string,
  elements: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      title: { tag: 'plain_text', content: headerTitle },
      template,
    },
    body: { elements },
  };
}

/**
 * Build a JSON 2.0 interactive button. `value` is the legacy callback field
 * (still returned in `action.value` by 2.0 callbacks); `behaviors` is the
 * 2.0-native interaction declaration — both are set so the callback fires on
 * all client versions.
 */
export function button20(
  text: string,
  type: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    value,
    behaviors: [{ type: 'callback', value }],
  };
}

/**
 * Wrap buttons into JSON 2.0 `column_set` rows (2 per row) so they render in
 * a compact grid instead of stacking vertically.
 */
export function buttonRow20(
  buttons: Record<string, unknown>[],
  perRow = 2,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push({
      tag: 'column_set',
      flex_mode: 'bisect',
      horizontal_spacing: '8px',
      columns: buttons.slice(i, i + perRow).map((button) => ({
        tag: 'column',
        width: 'auto',
        elements: [button],
      })),
    });
  }
  return rows;
}
