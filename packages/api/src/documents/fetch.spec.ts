import { extractPage, fetchUrl, parsePublicUrl } from './fetch';

function response(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    ...init,
  });
}

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

describe('URL fetcher', () => {
  it('extracts clean Markdown, absolute image URLs, and colors', () => {
    const page = extractPage(
      `
        <html>
          <head>
            <title>Karriere Haus</title>
            <meta name="theme-color" content="#123456">
            <meta property="og:image" content="/social.jpg">
            <style>.button { color: #abcdef; }</style>
          </head>
          <body>
            <nav>Nicht übernehmen</nav>
            <main>
              <h1>Willkommen</h1>
              <p>Wir bauen <a href="/jobs">Karrieren</a>.</p>
              <img src="/logo.png" alt="Logo">
            </main>
            <script>alert('x')</script>
          </body>
        </html>
      `,
      new URL('https://karriere.haus/unternehmen'),
    );

    expect(page.title).toBe('Karriere Haus');
    expect(page.markdown).toContain('# Willkommen');
    expect(page.markdown).toContain('[Karrieren](https://karriere.haus/jobs)');
    expect(page.markdown).not.toContain('Nicht übernehmen');
    expect(page.markdown).not.toContain('alert');
    expect(page.images).toEqual([
      { url: 'https://karriere.haus/social.jpg', alt: 'Open-Graph-Bild' },
      { url: 'https://karriere.haus/logo.png', alt: 'Logo' },
    ]);
    expect(page.colors).toEqual(expect.arrayContaining(['#123456', '#abcdef']));
  });

  it('rejects private targets and credentials in URLs', () => {
    expect(() => parsePublicUrl('http://127.0.0.1/admin')).toThrow('nicht erlaubt');
    expect(() => parsePublicUrl('https://user:pass@example.com')).toThrow('Zugangsdaten');
    expect(() => parsePublicUrl('file:///etc/passwd')).toThrow('http(s)');
  });

  it('rejects hostnames resolving to private addresses before fetching', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string | URL, RequestInit?]>();

    await expect(
      fetchUrl('https://example.com', {
        fetch: fetchMock,
        lookup: async () => [{ address: '10.0.0.2', family: 4 }],
      }),
    ).rejects.toThrow('nicht erlaubt');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honors robots.txt before returning page content', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string | URL, RequestInit?]>(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === '/robots.txt') {
        return response('User-agent: *\nDisallow: /intern', {
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      return response('<main>Geheim</main>');
    });

    await expect(
      fetchUrl('https://example.com/intern', { fetch: fetchMock, lookup: publicLookup }),
    ).rejects.toThrow('robots.txt');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('revalidates redirect targets and blocks redirects to private hosts', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string | URL, RequestInit?]>(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === '/robots.txt') {
        return response('', { headers: { 'Content-Type': 'text/plain' } });
      }
      return response('', {
        status: 302,
        headers: { Location: 'http://127.0.0.1/private' },
      });
    });

    await expect(
      fetchUrl('https://example.com/start', { fetch: fetchMock, lookup: publicLookup }),
    ).rejects.toThrow('nicht erlaubt');
  });

  it('fetches an allowed page and exposes its final URL', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string | URL, RequestInit?]>(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === '/robots.txt') {
        return response('User-agent: *\nAllow: /', {
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      return response('<main><h1>Angebot</h1><img src="/logo.png" alt="Logo"></main>');
    });

    await expect(
      fetchUrl('https://example.com/angebot', { fetch: fetchMock, lookup: publicLookup }),
    ).resolves.toMatchObject({
      url: 'https://example.com/angebot',
      markdown: expect.stringContaining('# Angebot'),
      images: [{ url: 'https://example.com/logo.png', alt: 'Logo' }],
      truncated: false,
    });
  });

  it('rejects responses over the size limit before reading them', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string | URL, RequestInit?]>(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === '/robots.txt') {
        return response('', { headers: { 'Content-Type': 'text/plain' } });
      }
      return response('zu groß', {
        headers: { 'Content-Type': 'text/html', 'Content-Length': '3000000' },
      });
    });

    await expect(
      fetchUrl('https://example.com/gross', { fetch: fetchMock, lookup: publicLookup }),
    ).rejects.toThrow('2048 KB');
  });
});
