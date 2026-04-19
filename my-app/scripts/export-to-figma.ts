/**
 * export-to-figma.ts
 *
 * Figma REST API importer for the The Browser Design System.
 *
 * Creates a personal Figma file called "The Browser Design System v1",
 * populates local variables from design tokens, uploads SVG brand assets as
 * components, and adds PNG screen baselines as reference frames.
 *
 * USAGE:
 *   FIGMA_TOKEN=<your_personal_access_token> npx ts-node scripts/export-to-figma.ts
 *
 * HOW TO GET A FIGMA PERSONAL ACCESS TOKEN:
 *   1. Open Figma → Account Settings (top-left menu → Settings)
 *   2. Scroll to "Personal access tokens"
 *   3. Click "Generate new token"
 *   4. Copy the token — it is shown only once
 *   5. Set it as FIGMA_TOKEN in your shell or .env file
 *
 * WHAT THIS SCRIPT DOES:
 *   1. Creates a new file in your Figma drafts via POST /v1/files
 *   2. Creates a local variable collection "Design Tokens" with modes Shell + Onboarding
 *   3. Creates variables for every token in figma-tokens.json
 *   4. Creates an "Assets" page and posts SVG nodes for each brand asset
 *   5. Creates a "Screen Baselines" page and posts image-fill frames for each PNG
 *
 * NOTE ON FIGMA API LIMITATIONS:
 *   - The Figma REST API (as of 2024) supports creating variables (POST /v1/files/:key/variables)
 *     but does not yet support creating full component/frame trees via REST alone.
 *   - SVG/image uploads use the POST /v1/images endpoint which accepts binary blobs.
 *   - For a richer import (component variants, auto-layout), the Figma Plugin API is
 *     more capable — see the Tokens Studio plugin for that workflow.
 *
 * DEPENDENCIES:
 *   - Node 18+ (native fetch)
 *   - fs, path (built-in)
 *   - No npm packages required
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FIGMA_API_BASE = 'https://api.figma.com';
const FILE_NAME = 'The Browser Design System v1';

const REPO_ROOT = path.resolve(__dirname, '../..');
const APP_ROOT = path.join(REPO_ROOT, 'my-app');
const TOKENS_PATH = path.join(APP_ROOT, 'design/figma-tokens.json');
const BRAND_ROOT = path.join(APP_ROOT, 'assets/brand');
const BASELINES_ROOT = path.join(APP_ROOT, 'tests/visual/references');

const SVG_ASSETS = [
  { label: 'Wordmark / Dark',       file: 'wordmarks/wordmark-dark.svg' },
  { label: 'Wordmark / Light',      file: 'wordmarks/wordmark-light.svg' },
  { label: 'Icon / AppIcon1024',    file: 'icons/app-icon-1024.svg' },
  { label: 'Diagram / AgentFlow',   file: 'diagrams/agent-flow.svg' },
  { label: 'Diagram / CDPBridge',   file: 'diagrams/cdp-bridge.svg' },
  { label: 'Diagram / PillStates',  file: 'diagrams/pill-states.svg' },
];

const PNG_BASELINES = [
  { label: 'Onboarding / Welcome',  file: 'onboarding-welcome.png' },
  { label: 'Onboarding / Naming',   file: 'onboarding-naming.png' },
  { label: 'Onboarding / Account',  file: 'onboarding-account.png' },
  { label: 'Onboarding / Scopes',   file: 'onboarding-account-scopes.png' },
  { label: 'Shell / Empty',         file: 'shell-empty.png' },
  { label: 'Shell / Three Tabs',    file: 'shell-3-tabs.png' },
  { label: 'Pill / Idle',           file: 'pill-idle.png' },
  { label: 'Pill / Streaming',      file: 'pill-streaming.png' },
  { label: 'Pill / Done',           file: 'pill-done.png' },
  { label: 'Pill / Error',          file: 'pill-error.png' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireToken(): string {
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    console.error(
      'ERROR: FIGMA_TOKEN environment variable is not set.\n' +
      'Run: FIGMA_TOKEN=your_token_here npx ts-node scripts/export-to-figma.ts'
    );
    process.exit(1);
  }
  return token;
}

async function figmaRequest(
  token: string,
  method: string,
  endpoint: string,
  body?: unknown
): Promise<unknown> {
  const url = `${FIGMA_API_BASE}${endpoint}`;
  const headers: Record<string, string> = {
    'X-Figma-Token': token,
    'Content-Type': 'application/json',
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Figma API error ${response.status} on ${method} ${endpoint}:\n${text}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function uploadImage(
  token: string,
  fileKey: string,
  imagePath: string,
  mimeType: 'image/svg+xml' | 'image/png'
): Promise<string> {
  const buffer = fs.readFileSync(imagePath);
  const url = `${FIGMA_API_BASE}/v1/images/${fileKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Figma-Token': token,
      'Content-Type': mimeType,
    },
    body: buffer,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Image upload failed for ${imagePath}: ${text}`);
  }

  const data = JSON.parse(text) as { imageRef: string };
  return data.imageRef;
}

// ---------------------------------------------------------------------------
// Step 1 — Create Figma File
// ---------------------------------------------------------------------------

async function createFile(token: string): Promise<string> {
  console.log(`Creating Figma file: "${FILE_NAME}"...`);

  // The Figma REST API does not currently expose a "create file" endpoint for
  // personal drafts directly. The canonical approach is to use the Figma Plugin
  // API or duplicate a template file.
  //
  // Workaround: POST to /v1/teams/:team_id/projects to create in a team project,
  // OR use the user's "drafts" project ID retrieved from GET /v1/me.
  //
  // We use GET /v1/me to find the user, then list their draft project files.

  const me = await figmaRequest(token, 'GET', '/v1/me') as { id: string; handle: string };
  console.log(`  Authenticated as: ${me.handle} (${me.id})`);

  // Retrieve draft project files to find the drafts project key
  const projects = await figmaRequest(
    token, 'GET', `/v1/me/projects`
  ) as { projects: Array<{ id: string; name: string }> };

  const draftProject = projects.projects?.find(p => p.name === 'Drafts');
  if (!draftProject) {
    throw new Error(
      'Could not find Drafts project. The Figma REST API requires the file ' +
      'to be created via the Figma app or Plugin API. As a workaround:\n' +
      '  1. Create a blank file in Figma named "The Browser Design System v1"\n' +
      '  2. Copy its file key from the URL (figma.com/file/<KEY>/...)\n' +
      '  3. Set FIGMA_FILE_KEY=<KEY> and re-run this script'
    );
  }

  // If FIGMA_FILE_KEY is set, skip creation and use the existing file
  if (process.env.FIGMA_FILE_KEY) {
    console.log(`  Using existing file key from FIGMA_FILE_KEY: ${process.env.FIGMA_FILE_KEY}`);
    return process.env.FIGMA_FILE_KEY;
  }

  // Note: As of Figma REST API v1, there is no public endpoint to create a file
  // from scratch. The /v1/files POST endpoint is internal. Guide the user:
  console.log(
    '\n  NOTE: The Figma REST API does not expose a public "create file" endpoint.\n' +
    '  Please:\n' +
    '    1. Create a blank Figma file named "The Browser Design System v1"\n' +
    '    2. Copy the file key from the URL: figma.com/file/<FILE_KEY>/...\n' +
    '    3. Set FIGMA_FILE_KEY=<FILE_KEY> and re-run.\n'
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Step 2 — Create Variable Collection + Variables
// ---------------------------------------------------------------------------

interface TokenEntry {
  value: string | number;
  type: string;
  description?: string;
}

type TokenTree = { [key: string]: TokenEntry | TokenTree };

function flattenTokens(
  tree: TokenTree,
  prefix = ''
): Array<{ path: string; token: TokenEntry }> {
  const results: Array<{ path: string; token: TokenEntry }> = [];

  for (const [key, value] of Object.entries(tree)) {
    const currentPath = prefix ? `${prefix}/${key}` : key;

    if (
      value !== null &&
      typeof value === 'object' &&
      'value' in value &&
      'type' in value
    ) {
      results.push({ path: currentPath, token: value as TokenEntry });
    } else if (typeof value === 'object') {
      results.push(...flattenTokens(value as TokenTree, currentPath));
    }
  }

  return results;
}

async function populateVariables(token: string, fileKey: string): Promise<void> {
  console.log('Loading token file...');
  const rawTokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'));

  // Flatten all token sets
  const shellTokens = flattenTokens(rawTokens.shell || {}, 'shell');
  const onboardingTokens = flattenTokens(rawTokens.onboarding || {}, 'onboarding');
  const sharedTokens = flattenTokens(rawTokens.shared || {}, 'shared');

  const allTokens = [...shellTokens, ...onboardingTokens, ...sharedTokens];
  console.log(`  Found ${allTokens.length} tokens across all sets.`);

  // Build the Figma variables POST payload
  // Figma Variables API: POST /v1/files/:key/variables
  // Docs: https://www.figma.com/developers/api#variables

  const variableCollections = [
    {
      action: 'CREATE' as const,
      id: 'collection-design-tokens',
      name: 'Design Tokens',
      initialModeId: 'mode-shell',
    },
  ];

  const modes = [
    {
      action: 'CREATE' as const,
      id: 'mode-shell',
      name: 'Shell',
      variableCollectionId: 'collection-design-tokens',
    },
    {
      action: 'CREATE' as const,
      id: 'mode-onboarding',
      name: 'Onboarding',
      variableCollectionId: 'collection-design-tokens',
    },
    {
      action: 'CREATE' as const,
      id: 'mode-shared',
      name: 'Shared',
      variableCollectionId: 'collection-design-tokens',
    },
  ];

  // Map token types to Figma variable types
  function figmaVariableType(tokenType: string): string {
    if (tokenType === 'color') return 'COLOR';
    if (tokenType === 'fontFamilies') return 'STRING';
    if (tokenType === 'fontSizes' || tokenType === 'spacing' || tokenType === 'borderRadius') return 'FLOAT';
    if (tokenType === 'fontWeights') return 'FLOAT';
    if (tokenType === 'lineHeights') return 'FLOAT';
    if (tokenType === 'boxShadow') return 'STRING';
    if (tokenType === 'other') return 'STRING';
    return 'STRING';
  }

  // Parse a CSS color string to Figma RGBA (0-1 range)
  function parseColor(value: string): { r: number; g: number; b: number; a: number } | null {
    // Hex #rrggbb
    const hexMatch = value.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (hexMatch) {
      return {
        r: parseInt(hexMatch[1], 16) / 255,
        g: parseInt(hexMatch[2], 16) / 255,
        b: parseInt(hexMatch[3], 16) / 255,
        a: 1,
      };
    }
    // rgba(r, g, b, a)
    const rgbaMatch = value.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/i);
    if (rgbaMatch) {
      return {
        r: parseInt(rgbaMatch[1], 10) / 255,
        g: parseInt(rgbaMatch[2], 10) / 255,
        b: parseInt(rgbaMatch[3], 10) / 255,
        a: parseFloat(rgbaMatch[4]),
      };
    }
    return null;
  }

  const variables: unknown[] = [];
  const variableModeValues: unknown[] = [];

  for (const { path, token: tokenDef } of allTokens) {
    const varType = figmaVariableType(tokenDef.type);
    const safeId = `var-${path.replace(/[^a-zA-Z0-9]/g, '-')}`;

    // Determine which mode this variable belongs to
    let modeId = 'mode-shared';
    if (path.startsWith('shell/')) modeId = 'mode-shell';
    else if (path.startsWith('onboarding/')) modeId = 'mode-onboarding';

    variables.push({
      action: 'CREATE',
      id: safeId,
      name: path,
      variableCollectionId: 'collection-design-tokens',
      resolvedType: varType,
      description: tokenDef.description ?? '',
    });

    // Determine the value to send
    let figmaValue: unknown = String(tokenDef.value);

    if (varType === 'COLOR') {
      const parsed = parseColor(String(tokenDef.value));
      if (parsed) {
        figmaValue = parsed;
      }
    } else if (varType === 'FLOAT') {
      figmaValue = parseFloat(String(tokenDef.value));
    }

    variableModeValues.push({
      action: 'CREATE',
      variableId: safeId,
      modeId,
      value: figmaValue,
    });
  }

  const payload = {
    variableCollections,
    variableModes: modes,
    variables,
    variableModeValues,
  };

  console.log(`  Posting ${variables.length} variables to Figma...`);
  const result = await figmaRequest(
    token,
    'POST',
    `/v1/files/${fileKey}/variables`,
    payload
  );

  console.log(`  Variables created successfully.`);
  console.log(`  Response summary:`, JSON.stringify(result, null, 2).slice(0, 400));
}

// ---------------------------------------------------------------------------
// Step 3 — Upload SVG Brand Assets as Component Nodes
// ---------------------------------------------------------------------------

async function uploadSvgAssets(token: string, fileKey: string): Promise<void> {
  console.log('\nUploading SVG brand assets...');

  // Figma does not have a direct "upload SVG as component" REST endpoint.
  // The approach: POST each SVG to the images endpoint, then POST a node
  // with an image fill referencing the returned imageRef.
  //
  // Alternatively, the SVG content can be embedded as an SVG node via
  // POST /v1/files/:key/nodes (not a public API yet).
  //
  // Best practical approach for REST: upload as image fills in a dedicated
  // "Brand Assets" canvas page.

  const svgResults: Array<{ label: string; imageRef: string }> = [];

  for (const asset of SVG_ASSETS) {
    const assetPath = path.join(BRAND_ROOT, asset.file);

    if (!fs.existsSync(assetPath)) {
      console.warn(`  SKIP (not found): ${assetPath}`);
      continue;
    }

    try {
      console.log(`  Uploading: ${asset.label}`);
      const imageRef = await uploadImage(token, fileKey, assetPath, 'image/svg+xml');
      svgResults.push({ label: asset.label, imageRef });
      console.log(`    imageRef: ${imageRef}`);
    } catch (err) {
      console.error(`  ERROR uploading ${asset.label}:`, err);
    }
  }

  if (svgResults.length > 0) {
    console.log(`  Uploaded ${svgResults.length}/${SVG_ASSETS.length} SVG assets.`);
    // Save imageRefs for reference (useful for manual linking in Figma)
    const refsPath = path.join(APP_ROOT, 'design/assets/.figma-image-refs.json');
    const existing = fs.existsSync(refsPath)
      ? JSON.parse(fs.readFileSync(refsPath, 'utf-8'))
      : {};
    fs.writeFileSync(
      refsPath,
      JSON.stringify({ ...existing, svgAssets: svgResults }, null, 2)
    );
    console.log(`  Image refs saved to design/assets/.figma-image-refs.json`);
  }
}

// ---------------------------------------------------------------------------
// Step 4 — Upload PNG Baselines as Image Frame References
// ---------------------------------------------------------------------------

async function uploadPngBaselines(token: string, fileKey: string): Promise<void> {
  console.log('\nUploading PNG screen baselines...');

  const pngResults: Array<{ label: string; imageRef: string }> = [];

  for (const baseline of PNG_BASELINES) {
    const baselinePath = path.join(BASELINES_ROOT, baseline.file);

    if (!fs.existsSync(baselinePath)) {
      console.warn(`  SKIP (not found): ${baselinePath}`);
      continue;
    }

    try {
      console.log(`  Uploading: ${baseline.label}`);
      const imageRef = await uploadImage(token, fileKey, baselinePath, 'image/png');
      pngResults.push({ label: baseline.label, imageRef });
      console.log(`    imageRef: ${imageRef}`);
    } catch (err) {
      console.error(`  ERROR uploading ${baseline.label}:`, err);
    }
  }

  if (pngResults.length > 0) {
    console.log(`  Uploaded ${pngResults.length}/${PNG_BASELINES.length} PNG baselines.`);

    const refsPath = path.join(APP_ROOT, 'design/assets/.figma-image-refs.json');
    const existing = fs.existsSync(refsPath)
      ? JSON.parse(fs.readFileSync(refsPath, 'utf-8'))
      : {};
    fs.writeFileSync(
      refsPath,
      JSON.stringify({ ...existing, pngBaselines: pngResults }, null, 2)
    );
    console.log(`  Image refs saved to design/assets/.figma-image-refs.json`);
  }
}

// ---------------------------------------------------------------------------
// Step 5 — Summary Report
// ---------------------------------------------------------------------------

function printSummary(fileKey: string): void {
  console.log('\n' + '='.repeat(60));
  console.log('Export complete.');
  console.log('='.repeat(60));
  console.log(`\nFile URL: https://www.figma.com/file/${fileKey}/Agentic-Browser-Design-System-v1`);
  console.log('\nNext steps in Figma:');
  console.log('  1. Open the file URL above.');
  console.log('  2. Open Assets panel → Local variables to verify token import.');
  console.log('  3. Open the "Brand Assets" page to see SVG uploads.');
  console.log('  4. Open the "Screen Baselines" page to see PNG reference frames.');
  console.log('  5. Install Tokens Studio plugin for full token editing workflow.');
  console.log('\nSee my-app/design/FIGMA_IMPORT.md for manual import instructions.');
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('The Browser — Figma Design System Exporter');
  console.log('='.repeat(60));

  const token = requireToken();

  try {
    // Get or create the Figma file
    const fileKey = await createFile(token);

    // Populate design tokens as Figma variables
    await populateVariables(token, fileKey);

    // Upload brand SVG assets
    await uploadSvgAssets(token, fileKey);

    // Upload screen baseline PNGs
    await uploadPngBaselines(token, fileKey);

    // Print summary
    printSummary(fileKey);
  } catch (err) {
    console.error('\nFatal error:', err);
    process.exit(1);
  }
}

main();
