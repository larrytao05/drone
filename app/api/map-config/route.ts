import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const runtimeEnvironment = process.env;
  const mode = runtimeEnvironment.DRONE_MAP_MODE;
  const noStore = { 'Cache-Control': 'no-store, max-age=0' };

  if (mode === 'local') {
    return NextResponse.json({ kind: 'local' }, { headers: noStore });
  }
  if (mode !== undefined && mode !== '' && mode !== 'provider') {
    return NextResponse.json({ error: 'Unknown map mode' }, { status: 500, headers: noStore });
  }

  const key = runtimeEnvironment.MAPTILER_API_KEY?.trim();
  if (!key) return NextResponse.json({ kind: 'missing' }, { headers: noStore });

  return NextResponse.json({
    kind: 'provider',
    styleUrl: `https://api.maptiler.com/maps/hybrid-v4/style.json?key=${encodeURIComponent(key)}`,
  }, { headers: noStore });
}
