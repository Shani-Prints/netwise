/**
 * Hebrew final letters are written in source as a digit after the letter (1 = final kaf, 2 = final mem, 3 = final nun,
 * 4 = final pe, 5 = final tsadi) and turned into the real letter at run time by fin(). So the source never contains them.
 * Example: fin('שניב2') is the word for "two" (masculine, plural form).
 */
const FINALS = 'ךםןףץ';

export const fin = (s: string): string => s.replace(/([א-ת])([1-5])/g, (_m, letter: string, d: string) => letter + FINALS[Number(d) - 1]);
