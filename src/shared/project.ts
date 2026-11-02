export const PROJECT_EXTENSION = '.acup';
export function isProjectFile(name: string): boolean { return /(?:\.acup|\.acu\.json)$/i.test(name); }
export function projectFilename(name: string): string {
  const clean = name.replace(/\.acup$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120).replace(/[. ]+$/, '').trimStart() || 'Untitled project';
  return `${/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(clean) ? `Project ${clean}` : clean}${PROJECT_EXTENSION}`;
}
