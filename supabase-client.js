// Environment selection. Local development (localhost / 127.0.0.1) uses the
// isolated development Supabase project and dev Worker; every other host
// (the deployed portal) uses production exactly as before.
// Only browser-safe keys belong here (anon / publishable). Never a secret key.
(function () {
  const ENVIRONMENTS = {
    production: {
      supabaseUrl: 'https://kcatufanwxhcoagyeskf.supabase.co',
      supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjYXR1ZmFud3hoY29hZ3llc2tmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NDUwNDcsImV4cCI6MjA5NjQyMTA0N30.l9tXgvvRt6AKQg3lmrk5WUNCEHPr9xu-CisV0uk-Jis',
      // WhatsApp AI admin APIs are not live in production yet.
      workerUrl: null
    },
    development: {
      supabaseUrl: 'https://ayfardmgbgbiaqjtizap.supabase.co',
      supabaseKey: 'sb_publishable_oBiBZi7JP1Cp7kr3xeXX0w_5iMOn-jl',
      workerUrl: 'https://smartcaptcha-ai-dev.smartcaptcha-ai.workers.dev'
    }
  };

  const host = window.location.hostname;
  const name = host === 'localhost' || host === '127.0.0.1' ? 'development' : 'production';
  const config = ENVIRONMENTS[name];

  window.SMARTCAP_ENV = Object.freeze({ name, ...config });
  window.supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseKey);

  // Make a non-production database impossible to miss.
  if (name !== 'production') {
    document.addEventListener('DOMContentLoaded', () => {
      const badge = document.getElementById('env-badge');
      if (badge) {
        badge.textContent = name.toUpperCase();
        badge.classList.remove('hidden');
      }
      document.title = `[${name.toUpperCase()}] ${document.title}`;
    });
  }
})();
