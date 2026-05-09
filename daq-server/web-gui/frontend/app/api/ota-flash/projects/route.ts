import { NextResponse } from 'next/server';
import { discoverProjects } from '../../../../../backend/src/ota-build';

export async function GET() {
  try {
    return NextResponse.json({ projects: discoverProjects() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
