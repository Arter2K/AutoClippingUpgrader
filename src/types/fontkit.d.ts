declare module 'fontkit' {
  export interface Font { familyName: string; fullName: string; subfamilyName: string; unitsPerEm: number; ascent: number; descent: number;
    layout(text: string): { positions: Array<{ xAdvance: number }> } }
  export function openSync(file: string): Font;
}
