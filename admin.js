document.addEventListener('DOMContentLoaded', async () => {
  const authContainer = document.getElementById('auth-container');
  const dashboardContainer = document.getElementById('dashboard-container');
  const loginForm = document.getElementById('login-form');
  const logoutBtn = document.getElementById('logout-btn');
  const authError = document.getElementById('auth-error');
  const loginBtn = loginForm.querySelector('button[type="submit"]');

  // Attach listener synchronously to prevent form reload!
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    
    authError.classList.add('hidden');
    loginBtn.textContent = 'Logging in...';
    loginBtn.disabled = true;

    try {
      const { data, error } = await window.supabaseClient.auth.signInWithPassword({ email, password });
      
      if (error) {
        throw error;
      }
      
      if (data.session) {
        showDashboard();
      }
    } catch (err) {
      authError.textContent = err.message || 'Login failed.';
      authError.classList.remove('hidden');
    } finally {
      loginBtn.textContent = 'Login';
      loginBtn.disabled = false;
    }
  });

  // Auth Listener
  window.supabaseClient.auth.onAuthStateChange((event, session) => {
    if (session) {
      showDashboard();
    } else {
      showLogin();
    }
  });

  // Check auth state on load
  const { data: { session } } = await window.supabaseClient.auth.getSession();
  if (session) {
    showDashboard();
  } else {
    showLogin();
  }

  // Logout
  logoutBtn.addEventListener('click', async () => {
    await window.supabaseClient.auth.signOut();
  });

  function showDashboard() {
    authContainer.classList.add('hidden');
    dashboardContainer.classList.remove('hidden');
    loadGallery();
    loadPackages();
  }

  function showLogin() {
    authContainer.classList.remove('hidden');
    dashboardContainer.classList.add('hidden');
  }

  // Tab Switching
  document.querySelectorAll('.admin-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.admin-tabs .tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active', 'hidden'));
      document.querySelectorAll('.admin-section').forEach(s => s.classList.add('hidden'));
      
      tab.classList.add('active');
      document.getElementById(`${tab.dataset.target}-tab`).classList.remove('hidden');
      document.getElementById(`${tab.dataset.target}-tab`).classList.add('active');
    });
  });

  // -----------------------------------------
  // STATISTICS & METRICS
  // -----------------------------------------
  async function updateStats() {
    try {
      const { count: pkgCount, error: pkgErr } = await window.supabaseClient.from('packages').select('*', { count: 'exact', head: true });
      const { count: imgCount, error: imgErr } = await window.supabaseClient.from('gallery_images').select('*', { count: 'exact', head: true });
      
      if (!pkgErr && pkgCount !== null) {
        document.getElementById('stat-total-packages').textContent = pkgCount;
      }
      if (!imgErr && imgCount !== null) {
        document.getElementById('stat-total-images').textContent = imgCount;
      }
    } catch (err) {
      console.error('Error updating stats:', err);
    }
  }

  // -----------------------------------------
  // GALLERY MANAGEMENT
  // -----------------------------------------
  async function loadGallery() {
    const grid = document.getElementById('admin-gallery-grid');
    grid.innerHTML = 'Loading...';
    const { data, error } = await window.supabaseClient.from('gallery_images').select('*').order('created_at', { ascending: false });
    
    if (error) {
      grid.innerHTML = 'Error loading gallery: ' + error.message;
      return;
    }

    // Update stats dynamically
    updateStats();

    if (data.length === 0) {
      grid.innerHTML = 'No images found.';
      return;
    }

    grid.innerHTML = data.map(img => `
      <div class="admin-image-card">
        <img src="${img.src}" alt="Gallery Image">
        <button class="delete-btn" data-id="${img.id}">X</button>
      </div>
    `).join('');

    // Delete handlers
    grid.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        if (!confirm('Delete this image?')) return;
        const id = e.target.dataset.id;
        await window.supabaseClient.from('gallery_images').delete().eq('id', id);
        loadGallery();
      });
    });
  }

  // Upload Gallery Image
  const uploadInput = document.getElementById('upload-gallery-input');
  const galleryStatus = document.getElementById('gallery-status');
  
  uploadInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    galleryStatus.textContent = 'Uploading to storage...';
    
    const fileExt = file.name.split('.').pop();
    const fileName = `${Math.random().toString(36).substring(2)}.${fileExt}`;
    const filePath = `gallery/${fileName}`;

    // 1. Upload to Supabase Storage Bucket ('media')
    const { error: uploadError } = await window.supabaseClient.storage.from('media').upload(filePath, file);
    
    if (uploadError) {
      galleryStatus.textContent = 'Upload failed: ' + uploadError.message;
      return;
    }

    // 2. Get Public URL
    const { data: { publicUrl } } = window.supabaseClient.storage.from('media').getPublicUrl(filePath);

    // 3. Insert into database
    galleryStatus.textContent = 'Saving to database...';
    const { error: dbError } = await window.supabaseClient.from('gallery_images').insert([{
      src: publicUrl,
      type: 'image',
      category: 'image'
    }]);

    if (dbError) {
      galleryStatus.textContent = 'DB Save failed: ' + dbError.message;
    } else {
      galleryStatus.textContent = 'Upload successful!';
      setTimeout(() => galleryStatus.textContent = '', 3000);
      loadGallery();
    }
  });

  // -----------------------------------------
  // PACKAGE MANAGEMENT
  // -----------------------------------------
  const addPkgBtn = document.getElementById('add-package-btn');
  const cancelAddPkgBtn = document.getElementById('cancel-add-pkg-btn');
  const addPkgFormContainer = document.getElementById('add-package-form-container');
  const addPkgForm = document.getElementById('add-package-form');
  const packagesList = document.getElementById('admin-packages-list');

  // Toggle Form
  addPkgBtn.addEventListener('click', () => {
    resetPackageForm();
    addPkgFormContainer.classList.toggle('hidden');
  });

  // Form Reset Helper
  function resetPackageForm() {
    addPkgForm.reset();
    delete addPkgForm.dataset.editId;
    document.getElementById('pkg-form-title').textContent = 'Add New Package';
    document.getElementById('pkg-save-btn').textContent = 'Save Package';
  }

  cancelAddPkgBtn.addEventListener('click', () => {
    addPkgFormContainer.classList.add('hidden');
    resetPackageForm();
  });

  // Load Packages
  async function loadPackages() {
    packagesList.innerHTML = 'Loading...';
    const { data, error } = await window.supabaseClient.from('packages').select('*').order('created_at', { ascending: false });
    
    if (error) {
      packagesList.innerHTML = 'Error loading packages: ' + error.message;
      return;
    }

    // Update stats dynamically
    updateStats();

    if (data.length === 0) {
      packagesList.innerHTML = 'No packages found. Run the seed script or add a new package.';
      return;
    }

    packagesList.innerHTML = data.map(pkg => `
      <div class="admin-item" data-id="${pkg.id}">
        <div class="admin-item-info">
          <h4>${pkg.title} <span style="font-size:0.8rem; color:var(--gold); margin-left:0.5rem; border:1px solid var(--gold); padding:2px 6px; border-radius:4px;">${pkg.tone}</span>${pkg.tab ? `<span style="font-size:0.75rem; color:var(--muted); margin-left:0.4rem; border:1px solid rgba(255,255,255,0.15); padding:2px 6px; border-radius:4px;">${pkg.tab}</span>` : ''}</h4>
          <p>Category: ${pkg.category} | Price: ${pkg.price} ${pkg.location ? `| Location: ${pkg.location}` : ''} ${pkg.featured ? '| ★ Featured' : ''}</p>
        </div>
        <div class="admin-item-actions">
          <button class="button edit edit-pkg-btn" data-id="${pkg.id}">Edit</button>
          <button class="button danger delete-pkg-btn" data-id="${pkg.id}">Delete</button>
        </div>
      </div>
    `).join('');

    // Attach edit listeners
    packagesList.querySelectorAll('.edit-pkg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const pkg = data.find(p => p.id === id);
        if (!pkg) return;
        
        // Populate form
        document.getElementById('pkg-title').value = pkg.title;
        document.getElementById('pkg-category').value = pkg.category;
        document.getElementById('pkg-price').value = pkg.price;
        document.getElementById('pkg-tone').value = pkg.tone;
        document.getElementById('pkg-tab').value = pkg.tab || '';
        document.getElementById('pkg-location').value = pkg.location || '';
        document.getElementById('pkg-photo').value = pkg.photo_url || '';
        document.getElementById('pkg-bullets').value = (pkg.bullets || []).join('\n');
        document.getElementById('pkg-tags').value = (pkg.tags || []).join(', ');
        document.getElementById('pkg-featured').checked = pkg.featured || false;
        
        addPkgForm.dataset.editId = pkg.id;
        document.getElementById('pkg-form-title').textContent = `Edit Package: ${pkg.title}`;
        document.getElementById('pkg-save-btn').textContent = 'Update Package';
        
        addPkgFormContainer.classList.remove('hidden');
        addPkgFormContainer.scrollIntoView({ behavior: 'smooth' });
      });
    });

    // Attach delete listeners
    packagesList.querySelectorAll('.delete-pkg-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        if (!confirm('Are you sure you want to delete this package?')) return;
        const id = e.target.dataset.id;
        
        const { error: delErr } = await window.supabaseClient.from('packages').delete().eq('id', id);
        if (delErr) {
          alert('Delete failed: ' + delErr.message);
        } else {
          loadPackages();
        }
      });
    });
  }

  // Add/Edit Package Submit
  addPkgForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const title = document.getElementById('pkg-title').value.trim();
    const category = document.getElementById('pkg-category').value.trim();
    const price = document.getElementById('pkg-price').value.trim();
    const tone = document.getElementById('pkg-tone').value;
    const tabVal = document.getElementById('pkg-tab').value.trim();
    const tab = tabVal || null;
    const locationVal = document.getElementById('pkg-location').value;
    const location = locationVal || null;
    const photo = document.getElementById('pkg-photo').value.trim() || 'assets/photos/studio-portrait.jpg';
    const bulletsRaw = document.getElementById('pkg-bullets').value;
    const tagsRaw = document.getElementById('pkg-tags').value;
    const featured = document.getElementById('pkg-featured').checked;

    // Process bullets
    const bullets = bulletsRaw.split('\n')
      .map(b => b.trim())
      .filter(b => b.length > 0);

    // Process tags
    const tags = tagsRaw.split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0);

    const packageData = {
      title,
      category,
      price,
      tone,
      tab,
      location,
      photo_url: photo,
      bullets,
      tags,
      featured
    };

    const editId = addPkgForm.dataset.editId;
    const submitBtn = document.getElementById('pkg-save-btn');
    submitBtn.textContent = editId ? 'Updating...' : 'Saving...';
    submitBtn.disabled = true;

    try {
      if (editId) {
        // Update existing package
        const { error: updErr } = await window.supabaseClient.from('packages').update(packageData).eq('id', editId);
        if (updErr) throw updErr;
      } else {
        // Insert new package
        const { error: insErr } = await window.supabaseClient.from('packages').insert([packageData]);
        if (insErr) throw insErr;
      }

      addPkgFormContainer.classList.add('hidden');
      resetPackageForm();
      loadPackages();
    } catch (err) {
      alert('Error saving package: ' + err.message);
    } finally {
      submitBtn.disabled = false;
    }
  });

  // -----------------------------------------
  // SEED DATA TOOL
  // -----------------------------------------
  const seedBtn = document.getElementById('seed-data-btn');
  const seedStatus = document.getElementById('seed-status');

  seedBtn.addEventListener('click', async () => {
    if (!confirm('Are you sure? This will insert all your hardcoded packages and gallery data into Supabase.')) return;
    
    seedStatus.textContent = 'Migrating packages...';
    seedBtn.disabled = true;

    try {
      // 0. Clear existing records to avoid duplicates
      seedStatus.textContent = 'Clearing existing records...';
      await window.supabaseClient.from('packages').delete().not('id', 'is', null);
      await window.supabaseClient.from('gallery_images').delete().not('id', 'is', null);

      // 1. Migrate Packages (from window.defaultPackages in script.js)
      let packagesToInsert = [];
      for (const [mainCat, items] of Object.entries(window.defaultPackages)) {
        items.forEach(p => {
          packagesToInsert.push({
            category: p.category,
            title: p.title,
            tab: p.tab || null,
            location: p.location || null,
            price: p.price,
            tone: p.tone,
            photo_url: p.photo,
            bullets: p.bullets,
            tags: p.tags,
            featured: p.featured || false
          });
        });
      }

      if (packagesToInsert.length > 0) {
        const { error: pkgErr } = await window.supabaseClient.from('packages').insert(packagesToInsert);
        if (pkgErr) throw pkgErr;
      }

      // 2. Migrate Gallery (from window.legacyGalleryData)
      seedStatus.textContent = 'Migrating gallery images to storage...';
      if (window.legacyGalleryData && window.legacyGalleryData.length > 0) {
        const migratedGallery = [];
        for (let i = 0; i < window.legacyGalleryData.length; i++) {
          const item = window.legacyGalleryData[i];
          const filename = item.src.split('/').pop();
          seedStatus.textContent = `Uploading gallery image ${i + 1}/${window.legacyGalleryData.length}: ${filename}...`;
          
          try {
            // Fetch file from local server
            const res = await fetch('smartcaptcha/' + filename);
            if (!res.ok) throw new Error(`Could not fetch smartcaptcha/${filename}`);
            const blob = await res.blob();
            
            // Upload to Supabase Storage
            const filePath = `gallery/${filename}`;
            const { error: uploadError } = await window.supabaseClient.storage.from('media').upload(filePath, blob, { upsert: true });
            if (uploadError) throw uploadError;
            
            // Get Public URL
            const { data: { publicUrl } } = window.supabaseClient.storage.from('media').getPublicUrl(filePath);
            
            migratedGallery.push({
              src: publicUrl,
              type: item.type || 'image',
              category: item.category || 'image'
            });
          } catch (uploadErr) {
            console.error(`Failed to migrate ${filename}:`, uploadErr);
            // Fallback to legacy path if upload fails
            migratedGallery.push(item);
          }
        }

        // Insert new records with public URLs into Supabase
        seedStatus.textContent = 'Saving gallery to database...';
        if (migratedGallery.length > 0) {
          const { error: galErr } = await window.supabaseClient.from('gallery_images').insert(migratedGallery);
          if (galErr) throw galErr;
        }
      }

      seedStatus.textContent = 'Migration Complete! You can now use the dashboard to manage content.';
      loadGallery();
      loadPackages();
    } catch (err) {
      seedStatus.textContent = 'Error during migration: ' + err.message;
      console.error(err);
    }
    
    seedBtn.disabled = false;
  });

});
