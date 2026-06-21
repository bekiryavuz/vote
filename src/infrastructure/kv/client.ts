import { config } from '@/infrastructure/config';

// Raw Upstash / Vercel KV REST transport. The only module that speaks HTTP to KV.

function buildKvUrl(path: string) {
    return `${config.kv.url.replace(/\/$/, '')}/${path}`;
}

function authHeader() {
    return { Authorization: `Bearer ${config.kv.token}` };
}

async function parseKvText(text: string) {
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && 'result' in parsed) {
            return parsed.result;
        }
        return parsed;
    } catch {
        return text;
    }
}

export async function kvGetRaw(key: string) {
    const res = await fetch(buildKvUrl(`get/${key}`), { headers: authHeader() });
    const text = await res.text();
    if (!res.ok) {
        return null;
    }
    return parseKvText(text);
}

export async function kvGetJson<T>(key: string): Promise<T | null> {
    const raw = await kvGetRaw(key);
    if (raw == null) {
        return null;
    }
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw) as T;
        } catch {
            return null;
        }
    }
    return raw as T;
}

export async function kvSet(key: string, value: unknown) {
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    const res = await fetch(buildKvUrl(`set/${key}`), {
        method: 'POST',
        headers: authHeader(),
        body
    });
    return res.ok;
}

export async function kvDelete(key: string) {
    const res = await fetch(buildKvUrl(`del/${key}`), {
        method: 'POST',
        headers: authHeader()
    });
    return res.ok;
}

export async function kvListKeys(pattern: string): Promise<string[]> {
    const res = await fetch(buildKvUrl(`keys/${pattern}`), { headers: authHeader() });
    if (!res.ok) {
        return [];
    }
    const data = await res.json().catch(() => null);
    if (data && Array.isArray(data.result)) {
        return data.result;
    }
    if (Array.isArray(data)) {
        return data;
    }
    return [];
}
