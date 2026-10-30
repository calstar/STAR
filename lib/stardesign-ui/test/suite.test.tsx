/**
 * The suite switcher's addresses: every app's header links the other two, and a
 * wrong mapping sends someone on stage to the wrong app (or a dead port).
 */
import { render, screen } from '@testing-library/react';
import { SuiteSwitcher } from '../src/SuiteSwitcher';
import { SUITE, siblingUrl, suiteUrlsFrom, type SuiteApp } from '../src/suite';

const at = (hostname: string, port = '', protocol = 'http:') => ({ protocol, hostname, port });

describe('siblingUrl', () => {
  it('maps every dev port to each sibling on the dev stack', () => {
    const dev: Record<SuiteApp, number> = { engine: 5173, pid: 5174, twin: 5177 };
    for (const from of SUITE) {
      for (const to of SUITE) {
        expect(siblingUrl(to.app, at('localhost', String(dev[from.app])))).toBe(`http://localhost:${dev[to.app]}/`);
      }
    }
  });

  it('keeps the demo stack on the demo stack', () => {
    expect(siblingUrl('pid', at('localhost', '5273'))).toBe('http://localhost:5274/');
    expect(siblingUrl('twin', at('localhost', '5274'))).toBe('http://localhost:5277/');
    expect(siblingUrl('engine', at('127.0.0.1', '5277'))).toBe('http://127.0.0.1:5273/');
  });

  it('writes an IPv6 loopback in brackets', () => {
    expect(siblingUrl('twin', at('[::1]', '5173'))).toBe('http://[::1]:5177/');
    expect(siblingUrl('twin', at('::1', '5173'))).toBe('http://[::1]:5177/');
  });

  it('gives no address for a local port it does not know', () => {
    expect(siblingUrl('engine', at('localhost', '8003'))).toBeNull();
    expect(siblingUrl('engine', at('localhost', ''))).toBeNull();
  });

  it('swaps the subdomain on the deployed site', () => {
    const here = at('feed-twin.starberkeley.org', '', 'https:');
    expect(siblingUrl('engine', here)).toBe('https://engine-design.starberkeley.org/');
    expect(siblingUrl('pid', here)).toBe('https://pid-designer.starberkeley.org/');
    expect(siblingUrl('twin', at('PID-Designer.starberkeley.org', '', 'https:'))).toBe(
      'https://feed-twin.starberkeley.org/',
    );
  });

  it('does not guess on other subdomains or other sites', () => {
    expect(siblingUrl('engine', at('daq-server.starberkeley.org', '', 'https:'))).toBeNull();
    expect(siblingUrl('engine', at('starberkeley.org', '', 'https:'))).toBeNull();
    expect(siblingUrl('engine', at('feed-twin.starberkeley.org.evil.com', '', 'https:'))).toBeNull();
    expect(siblingUrl('engine', at('example.com', '5177'))).toBeNull();
  });

  it("takes the build's address over anything worked out", () => {
    const given = suiteUrlsFrom({ VITE_HOTBENCH_ENGINE_URL: ' https://engine.example/ ', VITE_HOTBENCH_PID_URL: '' });
    expect(given).toEqual({ engine: 'https://engine.example/' });
    expect(siblingUrl('engine', at('localhost', '5177'), given)).toBe('https://engine.example/');
    expect(siblingUrl('pid', at('localhost', '5177'), given)).toBe('http://localhost:5174/');
    expect(suiteUrlsFrom(undefined)).toEqual({});
  });
});

describe('SuiteSwitcher', () => {
  it('marks the current app and links the other two', () => {
    render(<SuiteSwitcher app="twin" where={at('localhost', '5277')} />);
    const twin = screen.getByText('Twin');
    expect(twin).toHaveAttribute('aria-current', 'page');
    expect(twin.tagName).toBe('SPAN');
    expect(screen.getByText('Engine').closest('a')).toHaveAttribute('href', 'http://localhost:5273/');
    expect(screen.getByText('P&ID').closest('a')).toHaveAttribute('href', 'http://localhost:5274/');
    expect(screen.getByText('Hotbench')).toBeInTheDocument();
    expect(screen.getByText('a STAR project')).toBeInTheDocument();
  });

  it("makes the current app's name its home when the app gives one", async () => {
    const onHome = vi.fn();
    render(<SuiteSwitcher app="engine" onHome={onHome} where={at('localhost', '5173')} />);
    screen.getByText('Engine').click();
    expect(onHome).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Engine')).toHaveAttribute('aria-current', 'page');
  });

  it('does not link a sibling it has no address for', () => {
    render(<SuiteSwitcher app="pid" where={at('example.com', '')} />);
    expect(screen.getByText('Engine').closest('a')).toBeNull();
    expect(screen.getByText('Twin').closest('a')).toBeNull();
    expect(screen.getByText('Twin')).toHaveAttribute('title', expect.stringContaining('not served next to this copy'));
  });
});
