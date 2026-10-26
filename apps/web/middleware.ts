import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth';

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const loggedIn = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  if (pathname === '/login') {
    return loggedIn ? NextResponse.redirect(new URL('/', req.url)) : NextResponse.next();
  }
  if (loggedIn) return NextResponse.next();
  if (pathname.startsWith('/api/')) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  const url = new URL('/login', req.url);
  url.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(url);
}

export const config = {
  // Icons and brand files must load on /login too, so they skip the session check.
  matcher: ['/((?!auth/|_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|brand/).*)'],
};
