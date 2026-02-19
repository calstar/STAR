/**
 * Type definitions for uPlot
 * uPlot doesn't have official @types package, so we define our own
 */

declare module 'uplot' {
  export interface Options {
    title?: string;
    width?: number;
    height?: number;
    scales?: {
      [key: string]: {
        time?: boolean;
        auto?: boolean;
        range?: [number, number] | ((self: any, initMin: number, initMax: number, scaleKey: string) => [number, number]);
      };
    };
    axes?: Array<{
      stroke?: string;
      grid?: {
        show?: boolean;
        stroke?: string;
        width?: number;
      };
      ticks?: {
        show?: boolean;
        stroke?: string;
      };
      label?: string;
      value?: (self: any, rawValue: number, decimals: number, scaleKey: string) => string;
    }>;
    series?: Array<{
      label?: string;
      stroke?: string;
      width?: number;
      points?: {
        show?: boolean;
      };
      value?: (self: any, rawValue: number, decimals: number, seriesIdx: number) => string;
    }>;
    cursor?: {
      show?: boolean;
      x?: boolean;
      y?: boolean;
    };
    legend?: {
      show?: boolean;
      live?: boolean;
    };
  }

  export default class uPlot {
    constructor(opts: Options, data: [number[], ...number[][]], target: HTMLElement | null);
    setData(data: [number[], ...number[][]], skipUpdate?: boolean): void;
    setSize(size: { width: number; height: number }): void;
    destroy(): void;
  }
}
