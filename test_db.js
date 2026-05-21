import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://xbbzwitvlrdwnoushgpf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhiYnp3aXR2bHJkd25vdXNoZ3BmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkxNzUyNDgsImV4cCI6MjA4NDc1MTI0OH0.iSGt2DvhW5AS5HQCKobG2HrX3AVOLe4ub75nTAp6KI8';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function test() {
    const { data, error } = await supabase.from('action_products').select('*');
    console.log("DATA:", JSON.stringify(data, null, 2));
    console.log("ERROR:", error);
}

test();
