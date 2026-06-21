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

  let lastLoadedSessionId = null;

  async function refreshDashboardData(session) {
    if (!session) return;
    const sessionId = session.access_token;
    if (lastLoadedSessionId === sessionId) return;
    lastLoadedSessionId = sessionId;

    loadGallery();
    loadPackages();
    loadEventTypes();
    autoRestoreMissingData();
  }

  async function autoRestoreMissingData() {
    try {
      // 1. Restore 'others' if missing
      const { data: etData } = await window.supabaseClient.from('event_types').select('*').eq('key', 'others');
      if (etData && etData.length === 0) {
        console.log("Restoring missing 'others' event type...");
        await window.supabaseClient.from('event_types').insert({
          key: 'others',
          label: 'Other Events',
          icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
          tabs: ['Classic', 'Premium', 'Luxury']
        });
      }

      // 1b. Update Naming Ceremony event type tabs if they are using the old tabs
      const { data: namingEtData } = await window.supabaseClient.from('event_types').select('*').eq('key', 'naming');
      if (namingEtData && namingEtData.length > 0) {
        const expectedTabs = ["Photo only", "Video only", "Photo & Video", "Live Streaming"];
        const namingRow = namingEtData[0];
        const needsTabsUpdate = namingRow.tabs.length !== expectedTabs.length ||
                                namingRow.tabs.some((t, i) => t !== expectedTabs[i]);
        if (needsTabsUpdate) {
          console.log("Updating Naming Ceremony tabs in event_types database table...");
          await window.supabaseClient.from('event_types').update({ tabs: expectedTabs }).eq('key', 'naming');
        }
      }

      // 1c. Update Birthday Party event type tabs if they are using the old tabs
      const { data: birthdayEtData } = await window.supabaseClient.from('event_types').select('*').eq('key', 'birthday');
      if (birthdayEtData && birthdayEtData.length > 0) {
        const expectedTabs = ["Photo only", "Video only", "Photo & Video"];
        const birthdayRow = birthdayEtData[0];
        const needsTabsUpdate = birthdayRow.tabs.length !== expectedTabs.length ||
                                birthdayRow.tabs.some((t, i) => t !== expectedTabs[i]);
        if (needsTabsUpdate) {
          console.log("Updating Birthday Party tabs in event_types database table...");
          await window.supabaseClient.from('event_types').update({ tabs: expectedTabs }).eq('key', 'birthday');
        }
      }

      // 2. Restore missing packages
      let { data: pkgData } = await window.supabaseClient.from('packages').select('title,tone');
      if (pkgData) {
        // 2b. Sync Naming Ceremony packages if out of sync
        const namingPackagesInDB = pkgData.filter(p => p.tone === 'naming');
        const expectedNamingTitles = new Set(window.defaultPackages.naming.map(p => p.title.toLowerCase().trim()));
        
        const needsNamingSync = namingPackagesInDB.length !== window.defaultPackages.naming.length || 
                                namingPackagesInDB.some(p => !expectedNamingTitles.has(p.title.toLowerCase().trim()));
        
        if (needsNamingSync) {
          console.log("Naming Ceremony packages are out of sync in database. Synchronizing...");
          await window.supabaseClient.from('packages').delete().eq('tone', 'naming');
          const toInsertNaming = window.defaultPackages.naming.map(p => ({
            category: p.category,
            title: p.title,
            tab: p.tab || null,
            location: p.location || null,
            price: p.price,
            tone: p.tone,
            photo_url: p.photo || null,
            bullets: p.bullets || [],
            tags: p.tags || [],
            featured: p.featured || false
          }));
          const { error: syncErr } = await window.supabaseClient.from('packages').insert(toInsertNaming);
          if (syncErr) {
            console.error("Error syncing Naming Ceremony packages:", syncErr.message);
          } else {
            console.log("Naming Ceremony packages synchronized successfully.");
          }
          // Refetch packages to get latest state
          const { data: refetchedPkgData } = await window.supabaseClient.from('packages').select('title,tone');
          if (refetchedPkgData) {
            pkgData = refetchedPkgData;
          }
        }

        // 2c. Sync Birthday party packages if out of sync
        const birthdayPackagesInDB = pkgData.filter(p => p.tone === 'birthday');
        const expectedBirthdayTitles = new Set(window.defaultPackages.birthday.map(p => p.title.toLowerCase().trim()));
        
        const needsBirthdaySync = birthdayPackagesInDB.length !== window.defaultPackages.birthday.length || 
                                  birthdayPackagesInDB.some(p => !expectedBirthdayTitles.has(p.title.toLowerCase().trim()));
        
        if (needsBirthdaySync) {
          console.log("Birthday party packages are out of sync in database. Synchronizing...");
          await window.supabaseClient.from('packages').delete().eq('tone', 'birthday');
          const toInsertBirthday = window.defaultPackages.birthday.map(p => ({
            category: p.category,
            title: p.title,
            tab: p.tab || null,
            location: p.location || null,
            price: p.price,
            tone: p.tone,
            photo_url: p.photo || null,
            bullets: p.bullets || [],
            tags: p.tags || [],
            featured: p.featured || false
          }));
          const { error: syncErr } = await window.supabaseClient.from('packages').insert(toInsertBirthday);
          if (syncErr) {
            console.error("Error syncing Birthday party packages:", syncErr.message);
          } else {
            console.log("Birthday party packages synchronized successfully.");
          }
          // Refetch packages to get latest state
          const { data: refetchedPkgData } = await window.supabaseClient.from('packages').select('title,tone');
          if (refetchedPkgData) {
            pkgData = refetchedPkgData;
          }
        }

        const existingKeys = new Set(pkgData.map(p => `${p.title.trim().toLowerCase()}|${p.tone.trim().toLowerCase()}`));
        const missing = [];
        
        for (const [tone, list] of Object.entries(window.defaultPackages)) {
          list.forEach(p => {
            const key = `${p.title.trim().toLowerCase()}|${p.tone.trim().toLowerCase()}`;
            if (!existingKeys.has(key)) {
              missing.push(p);
            }
          });
        }

        if (missing.length > 0) {
          console.log(`Auto-restoring ${missing.length} missing packages...`);
          const toInsert = missing.map(p => ({
            category: p.category,
            title: p.title,
            tab: p.tab || null,
            location: p.location || null,
            price: p.price,
            tone: p.tone,
            photo_url: p.photo || null,
            bullets: p.bullets || [],
            tags: p.tags || [],
            featured: p.featured || false
          }));
          const { error: insertErr } = await window.supabaseClient.from('packages').insert(toInsert);
          if (insertErr) {
            console.error('Error auto-inserting missing packages:', insertErr.message);
          } else {
            console.log('Restored packages successfully.');
            loadPackages();
          }
        }
      }
    } catch (err) {
      console.error('Error auto-restoring missing data:', err);
    }
  }

  // Auth Listener
  window.supabaseClient.auth.onAuthStateChange((event, session) => {
    if (session) {
      showDashboard();
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') {
        refreshDashboardData(session);
      }
    } else {
      showLogin();
    }
  });

  // Check auth state on load
  const { data: { session } } = await window.supabaseClient.auth.getSession();
  if (session) {
    showDashboard();
    refreshDashboardData(session);
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
    setupEventTypesRealtime();
  }

  function showLogin() {
    authContainer.classList.remove('hidden');
    dashboardContainer.classList.add('hidden');
    lastLoadedSessionId = null; // reset
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
        <img src="${img.src}" loading="lazy" alt="Gallery Image">
        <button class="delete-btn" data-id="${img.id}">X</button>
      </div>
    `).join('');

    // Delete handlers
    grid.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        if (!confirm('Delete this image?')) return;
        const id = e.target.dataset.id;

        // 1. Get the image record to find its source URL
        const { data: imgData, error: fetchErr } = await window.supabaseClient
          .from('gallery_images')
          .select('src')
          .eq('id', id)
          .single();

        if (!fetchErr && imgData && imgData.src) {
          // Extract the storage path from the public URL
          let filePath = null;
          try {
            const url = new URL(imgData.src);
            const parts = url.pathname.split('/public/media/');
            if (parts.length > 1) {
              filePath = decodeURIComponent(parts[1]);
            }
          } catch (urlErr) {
            // Fallback if URL is relative or different format
            if (imgData.src.includes('/public/media/')) {
              filePath = decodeURIComponent(imgData.src.split('/public/media/')[1]);
            } else if (imgData.src.includes('/media/')) {
              const idx = imgData.src.indexOf('/media/');
              filePath = decodeURIComponent(imgData.src.substring(idx + 7));
            }
          }

          if (filePath) {
            // 2. Delete the file from the Supabase Storage bucket ('media')
            const { error: storageErr } = await window.supabaseClient.storage
              .from('media')
              .remove([filePath]);
            
            if (storageErr) {
              console.warn('Could not delete image from storage:', storageErr.message);
            }
          }
        }

        // 3. Delete from database
        const { error: dbErr } = await window.supabaseClient.from('gallery_images').delete().eq('id', id);
        if (dbErr) {
          alert('Failed to delete from database: ' + dbErr.message);
        }
        
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

  let loadedPackages = [];
  const packageSearchInput = document.getElementById('package-search-input');
  const packageCategoryFilter = document.getElementById('package-category-filter');

  packageSearchInput.addEventListener('input', renderPackages);
  packageCategoryFilter.addEventListener('change', renderPackages);

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
    // ONE-TIME AUTOMATIC MIGRATION FOR NEW BIRTHDAY PACKAGES
    try {
      const { data: { session } } = await window.supabaseClient.auth.getSession();
      if (session) {
        const migrationKey = 'birthday_packages_migrated_v4';
        if (!localStorage.getItem(migrationKey)) {
          console.log("Running automatic birthday packages migration (v4)...");
          
          // 1. Delete ONLY the old in-studio birthday and child birthday packages
          await window.supabaseClient
            .from('packages')
            .delete()
            .eq('location', 'In-studio')
            .in('category', ['Birthday shoot', 'Child Birthday']);
            
          // 2. Insert new packages (both Child Birthday and restored Birthday Shoot packages)
          const newPackages = [
            {
              title: "Silver Package",
              category: "Child Birthday",
              location: "In-studio",
              price: "GHS 500",
              tone: "portrait",
              photo_url: "assets/photos/studio-portrait.jpg",
              bullets: [
                "1-hour studio session.",
                "1 outfit.",
                "6 professionally edited photos.",
                "High-resolution digital delivery.",
                "Parent-child portraits included."
              ],
              tags: ["Studio Session", "Birthday Portraits", "Themed Setup", "Child Photography", "Props", "Photo Editing", "Retouching", "Digital Delivery"],
              featured: false,
              tab: null
            },
            {
              title: "Gold Package",
              category: "Child Birthday",
              location: "In-studio",
              price: "GHS 900",
              tone: "portrait",
              photo_url: "assets/photos/traditional-props.jpg",
              featured: true,
              bullets: [
                "Up to 2-hour studio session.",
                "Two themed setups.",
                "Up to 2 outfit changes.",
                "Birthday props provided.",
                "Cake smash session (cake provided by client).",
                "10 professionally edited photos.",
                "Family portraits included.",
                "High-resolution digital delivery."
              ],
              tags: ["Studio Session", "Multiple Outfits", "Themed Setup", "Cake Smash", "Child Portraits", "Family Portraits", "Photo Editing", "Digital Delivery"],
              tab: null
            },
            {
              title: "Platinum Package",
              category: "Child Birthday",
              location: "In-studio",
              price: "GHS 1,500",
              tone: "portrait",
              photo_url: "assets/photos/studio-portrait.jpg",
              featured: false,
              bullets: [
                "Up to 3-hour studio session.",
                "Premium birthday-themed setups.",
                "Multiple outfit changes.",
                "Premium props and decorations provided.",
                "Cake smash session.",
                "Family and sibling portraits.",
                "20 professionally edited photos.",
                "30-second birthday reel.",
                "One framed portrait."
              ],
              tags: ["Luxury Setup", "Multiple Themes", "Cake Smash", "Family Portraits", "Premium Retouching", "Birthday Reel", "Framed Portrait", "Digital Delivery"],
              tab: null
            },
            {
              title: "Signature Package",
              category: "Child Birthday",
              location: "In-studio",
              price: "GHS 3,000",
              tone: "portrait",
              photo_url: "assets/photos/traditional-props.jpg",
              featured: false,
              bullets: [
                "Fully customized birthday concept.",
                "Premium themed set design.",
                "Unlimited outfit changes.",
                "Luxury props and décor.",
                "Cake smash session.",
                "Family portraits.",
                "30 professionally edited photos.",
                "Cinematic birthday reel.",
                "Framed portrait.",
                "Mini photo album."
              ],
              tags: ["Luxury Experience", "Custom Theme", "Premium Props", "Family Portraits", "Birthday Reel", "Behind-The-Scenes", "Framed Portrait", "Photo Album"],
              tab: null
            },
            {
              title: "Mini Birthday Package",
              category: "Birthday shoot",
              location: "In-studio",
              price: "GHS 300",
              tone: "portrait",
              photo_url: "assets/photos/studio-portrait.jpg",
              bullets: [
                "30-minute studio session.",
                "1 outfit.",
                "1 backdrop.",
                "5 professionally edited photos.",
                "Soft copies delivered online."
              ],
              tags: ["5 photos", "1 outfit", "30 mins"],
              featured: false,
              tab: null
            },
            {
              title: "Classic Birthday Package",
              category: "Birthday shoot",
              location: "In-studio",
              price: "GHS 500",
              tone: "portrait",
              photo_url: "assets/photos/traditional-props.jpg",
              bullets: [
                "1-hour studio session.",
                "Up to 2 outfit changes.",
                "2 backdrop setups.",
                "10 professionally edited photos.",
                "Basic retouching.",
                "Soft copies delivered online."
              ],
              tags: ["10 photos", "2 outfits", "1 hour"],
              featured: false,
              tab: null
            },
            {
              title: "Premium Birthday Package",
              category: "Birthday shoot",
              location: "In-studio",
              price: "GHS 1,000",
              tone: "portrait",
              photo_url: "assets/photos/studio-portrait.jpg",
              bullets: [
                "2-hour studio session.",
                "Up to 3 outfit changes.",
                "Multiple backdrop setups.",
                "15 professionally edited photos.",
                "Advanced beauty retouching.",
                "Social media-ready images.",
                "30-second birthday reel."
              ],
              tags: ["15 photos", "3 outfits", "Reel included"],
              featured: false,
              tab: null
            },
            {
              title: "Luxury Birthday Package",
              category: "Birthday shoot",
              location: "In-studio",
              price: "GHS 2,000",
              tone: "portrait",
              photo_url: "assets/photos/traditional-props.jpg",
              bullets: [
                "Up to 3-hour studio session.",
                "Unlimited outfit changes.",
                "Premium themed setup.",
                "25 edited photos.",
                "Cinematic birthday reel.",
                "Premium retouching.",
                "Professional makeup service.",
                "One framed portrait (A3 size)."
              ],
              tags: ["25 photos", "Makeup included", "A3 portrait"],
              featured: false,
              tab: null
            }
          ];
          
          const { error: insErr } = await window.supabaseClient
            .from('packages')
            .insert(newPackages);
            
          if (!insErr) {
            localStorage.setItem(migrationKey, 'true');
            console.log("Automatic birthday packages migration (v4) completed successfully!");
            location.reload();
            return;
          } else {
            console.error("Migration insert failed:", insErr);
          }
        }
      }
    } catch (err) {
      console.error("Migration error:", err);
    }

    packagesList.innerHTML = 'Loading...';
    const { data, error } = await window.supabaseClient.from('packages').select('*').order('created_at', { ascending: false });
    
    if (error) {
      packagesList.innerHTML = 'Error loading packages: ' + error.message;
      return;
    }

    loadedPackages = data;

    // Check if the Classic Package is present in loadedPackages
    const hasClassicPackage = loadedPackages.some(pkg => pkg.title === 'Classic Package' && pkg.tone === 'birthday');
    if (!hasClassicPackage) {
      try {
        const { data: { session } } = await window.supabaseClient.auth.getSession();
        if (session) {
          console.log("Birthday Classic Package is missing from DB. Restoring...");
          const classicPackage = {
            title: "Classic Package",
            category: "Photo + Video",
            tab: "Photo + Video",
            price: "GHS 4,500",
            tone: "birthday",
            photo_url: "assets/photos/studio-portrait.jpg",
            bullets: [
              "Photography coverage",
              "Videography coverage",
              "100+ edited photos",
              "Full event video",
              "2–3 minute highlight"
            ],
            tags: ["Full video", "photo", "highlight"],
            featured: false,
            location: null
          };
          const { data: inserted, error: insErr } = await window.supabaseClient
            .from('packages')
            .insert([classicPackage])
            .select();
            
          if (!insErr && inserted && inserted.length > 0) {
            console.log("Classic Package restored successfully!");
            loadedPackages.unshift(inserted[0]);
          } else if (insErr) {
            console.error("Failed to restore Classic Package:", insErr.message);
          }
        }
      } catch (err) {
        console.error("Restoration error:", err);
      }
    }

    // Update stats dynamically
    updateStats();
    renderPackages();
  }

  // Render Grouped and Filtered Packages
  function renderPackages() {
    if (loadedPackages.length === 0) {
      packagesList.innerHTML = 'No packages found. Run the seed script or add a new package.';
      return;
    }

    const searchQuery = packageSearchInput.value.toLowerCase().trim();
    const categoryFilter = packageCategoryFilter.value;

    const filtered = loadedPackages.filter(pkg => {
      const titleMatches = pkg.title ? pkg.title.toLowerCase().includes(searchQuery) : false;
      const categoryMatches = pkg.category ? pkg.category.toLowerCase().includes(searchQuery) : false;
      const toneMatches = pkg.tone ? pkg.tone.toLowerCase().includes(searchQuery) : false;
      const tagsMatches = (pkg.tags && Array.isArray(pkg.tags)) ? pkg.tags.some(tag => tag.toLowerCase().includes(searchQuery)) : false;

      const matchesSearch = titleMatches || categoryMatches || toneMatches || tagsMatches;
      const matchesFilter = categoryFilter === 'all' || pkg.tone === categoryFilter;

      return matchesSearch && matchesFilter;
    });

    if (filtered.length === 0) {
      packagesList.innerHTML = '<div class="no-packages-found">No packages match your search or filter criteria.</div>';
      return;
    }

    // Group packages by tone (main category)
    const groups = {};
    filtered.forEach(pkg => {
      const tone = pkg.tone || 'uncategorized';
      if (!groups[tone]) {
        groups[tone] = [];
      }
      groups[tone].push(pkg);
    });

    const toneOrder = ['wedding', 'portrait', 'streaming', 'funeral', 'naming', 'corporate', 'concert', 'birthday', 'others', 'uncategorized'];
    let html = '';

    toneOrder.forEach(tone => {
      if (groups[tone] && groups[tone].length > 0) {
        const tonePackages = groups[tone];
        html += `
          <div class="package-group-section group-${tone}">
            <div class="package-group-header">
              <h3>${tone} Packages</h3>
              <span class="package-count-badge">${tonePackages.length} package${tonePackages.length > 1 ? 's' : ''}</span>
            </div>
            <div class="admin-list">
              ${tonePackages.map(pkg => `
                <div class="admin-item" data-id="${pkg.id}">
                  <div class="admin-item-info">
                    <h4>${pkg.title} ${pkg.featured ? '<span style="font-size:0.75rem; color:var(--teal-bright); margin-left:0.5rem; border:1px solid var(--teal-bright); padding:2px 6px; border-radius:4px;">★ Featured</span>' : ''}${pkg.tab ? `<span style="font-size:0.75rem; color:var(--muted); margin-left:0.4rem; border:1px solid rgba(255,255,255,0.15); padding:2px 6px; border-radius:4px;">${pkg.tab}</span>` : ''}</h4>
                    <p>Category: ${pkg.category} | Price: ${pkg.price} ${pkg.location ? `| Location: ${pkg.location}` : ''}</p>
                    ${pkg.tags && pkg.tags.length > 0 ? `
                      <div style="display: flex; gap: 0.35rem; margin-top: 0.5rem; flex-wrap: wrap;">
                        ${pkg.tags.map(t => `<span style="font-size: 0.72rem; padding: 1px 6px; background: rgba(255,255,255,0.05); border: 1px solid var(--line); border-radius: 4px; color: var(--muted);">${t}</span>`).join('')}
                      </div>
                    ` : ''}
                  </div>
                  <div class="admin-item-actions">
                    <button class="button edit edit-pkg-btn" data-id="${pkg.id}">Edit</button>
                    <button class="button danger delete-pkg-btn" data-id="${pkg.id}">Delete</button>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }
    });

    packagesList.innerHTML = html;

    // Attach edit listeners
    packagesList.querySelectorAll('.edit-pkg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const pkg = loadedPackages.find(p => p.id === id);
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
    if (!confirm('This will clear and re-seed all packages with the latest data. Your gallery images will NOT be affected. Continue?')) return;
    
    seedStatus.textContent = 'Seeding packages...';
    seedBtn.disabled = true;

    try {
      // Clear ONLY packages — gallery images are never touched by seed
      seedStatus.textContent = 'Clearing existing packages...';
      await window.supabaseClient.from('packages').delete().not('id', 'is', null);

      // Insert all packages from window.defaultPackages
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
        seedStatus.textContent = `Inserting ${packagesToInsert.length} packages...`;
        const { error: pkgErr } = await window.supabaseClient.from('packages').insert(packagesToInsert);
        if (pkgErr) throw pkgErr;
      }

      seedStatus.textContent = `✅ Done! ${packagesToInsert.length} packages seeded. Gallery images untouched.`;
      loadPackages();
    } catch (err) {
      seedStatus.textContent = '❌ Error: ' + err.message;
      console.error(err);
    }

    seedBtn.disabled = false;
  });

  // RESTORE GALLERY FROM STORAGE
  // Re-links any image files already in Supabase Storage back into the gallery_images table.
  const restoreGalleryBtn = document.getElementById('restore-gallery-btn');
  const restoreStatus = document.getElementById('restore-status');

  if (restoreGalleryBtn) {
    restoreGalleryBtn.addEventListener('click', async () => {
      if (!confirm('This will scan your Supabase Storage and re-add any gallery images that are missing from the database. Continue?')) return;

      restoreStatus.textContent = 'Scanning storage for images...';
      restoreGalleryBtn.disabled = true;

      try {
        // List all files in the gallery/ folder of the media bucket
        const { data: files, error: listErr } = await window.supabaseClient.storage.from('media').list('gallery', { limit: 500 });
        if (listErr) throw listErr;

        if (!files || files.length === 0) {
          restoreStatus.textContent = 'No files found in storage.';
          restoreGalleryBtn.disabled = false;
          return;
        }

        // Fetch existing DB records to avoid duplicates
        const { data: existing } = await window.supabaseClient.from('gallery_images').select('src');
        const existingUrls = new Set((existing || []).map(r => r.src));

        const toInsert = [];
        for (const file of files) {
          if (file.name === '.emptyFolderPlaceholder') continue;
          const { data: { publicUrl } } = window.supabaseClient.storage.from('media').getPublicUrl(`gallery/${file.name}`);
          if (!existingUrls.has(publicUrl)) {
            toInsert.push({ src: publicUrl, type: 'image', category: 'image' });
          }
        }

        if (toInsert.length === 0) {
          restoreStatus.textContent = '✅ All storage images are already in the database.';
        } else {
          const { error: insErr } = await window.supabaseClient.from('gallery_images').insert(toInsert);
          if (insErr) throw insErr;
          restoreStatus.textContent = `✅ Restored ${toInsert.length} image(s) from storage.`;
          loadGallery();
        }
      } catch (err) {
        restoreStatus.textContent = '❌ Error: ' + err.message;
        console.error(err);
      }

      restoreGalleryBtn.disabled = false;
    });
  }

  // -----------------------------------------
  // EVENT TYPES MANAGER & PRESETS
  // -----------------------------------------
  const ICON_PRESETS = {
    star: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2 7h7l-5.5 4 2 7L12 16l-5.5 4 2-7L3 9h7z"/></svg>`,
    heart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
    camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
    video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`,
    music: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
    calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    people: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`
  };

  const defaultEventTypes = [
    {
      key: "wedding",
      label: "Wedding",
      icon: ICON_PRESETS.heart,
      tabs: ["Photo & Video", "Live Streaming", "Drone"]
    },
    {
      key: "funeral",
      label: "Funeral",
      icon: ICON_PRESETS.people,
      tabs: ["Coverage", "Live Streaming", "Full Package"]
    },
    {
      key: "naming",
      label: "Naming Ceremony",
      icon: ICON_PRESETS.calendar,
      tabs: ["Photo only", "Video only", "Photo & Video", "Live Streaming"]
    },
    {
      key: "corporate",
      label: "Corporate Event",
      icon: ICON_PRESETS.people,
      tabs: ["Conference", "Launch & Party", "Award Night"]
    },
    {
      key: "concert",
      label: "Concert / Live Show",
      icon: ICON_PRESETS.music,
      tabs: ["Coverage", "Streaming", "Full Production"]
    },
    {
      key: "others",
      label: "Other Events",
      icon: ICON_PRESETS.star,
      tabs: ["Classic", "Premium", "Luxury"]
    }
  ];

  let loadedEventTypes = [];

  async function loadEventTypes() {
    if (!window.supabaseClient) return;

    try {
      const { data, error } = await window.supabaseClient
        .from('event_types')
        .select('*')
        .order('created_at', { ascending: true });

      if (error) {
        console.warn("Could not fetch event types (table may not exist yet):", error.message);
        loadedEventTypes = defaultEventTypes;
        populateToneDropdown();
        renderEventTypesList(true); // read-only fallback view
        return;
      }

      if (!data || data.length === 0) {
        console.log("event_types table is empty. Auto-seeding default event types...");
        const { error: seedErr } = await window.supabaseClient.from('event_types').insert(defaultEventTypes);
        if (seedErr) {
          console.error("Error auto-seeding event types:", seedErr.message);
        } else {
          const { data: refetched } = await window.supabaseClient
            .from('event_types')
            .select('*')
            .order('created_at', { ascending: true });
          if (refetched) {
            loadedEventTypes = refetched;
          }
        }
      } else {
        loadedEventTypes = data;
      }

      populateToneDropdown();
      renderEventTypesList(false);
    } catch (err) {
      console.error("Error in loadEventTypes:", err);
      loadedEventTypes = defaultEventTypes;
      populateToneDropdown();
      renderEventTypesList(true);
    }
  }

  function populateToneDropdown() {
    const select = document.getElementById('pkg-tone');
    if (!select) return;

    const savedVal = select.value;

    select.innerHTML = `
      <optgroup label="Events">
        ${loadedEventTypes.map(evt => `<option value="${evt.key}">${evt.label}</option>`).join('')}
      </optgroup>
      <optgroup label="Standalone">
        <option value="portrait">Portraits</option>
        <option value="streaming">Streaming</option>
      </optgroup>
    `;

    if (savedVal && Array.from(select.options).some(opt => opt.value === savedVal)) {
      select.value = savedVal;
    }
  }

  function renderEventTypesList(isFallback = false) {
    const listContainer = document.getElementById('admin-event-types-list');
    if (!listContainer) return;

    let html = '';

    if (isFallback) {
      html += `
        <div style="background: rgba(220, 100, 100, 0.1); border: 1px solid rgba(220, 100, 100, 0.3); padding: 1rem; border-radius: 6px; color: #ff8888; font-size: 0.9rem; margin-bottom: 1rem;">
          <strong>⚠️ Notice:</strong> The <code>event_types</code> table was not found in your database. 
          Please run the SQL migration script from the implementation plan in your Supabase dashboard to enable dynamic events. 
          Currently displaying hardcoded event types (read-only).
        </div>
      `;
    }

    if (loadedEventTypes.length === 0) {
      html += '<p>No event types defined.</p>';
      listContainer.innerHTML = html;
      return;
    }

    html += loadedEventTypes.map(evt => {
      const isSystemEvent = ['wedding', 'funeral', 'portrait', 'streaming'].includes(evt.key);
      const deleteBtn = isFallback 
        ? '' 
        : `<button class="button danger delete-evt-btn" data-key="${evt.key}" ${isSystemEvent ? 'disabled title="Core system events cannot be deleted"' : ''}>Delete</button>`;

      return `
        <div class="admin-item" style="padding: 1rem; margin-bottom: 0.5rem; display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px;">
          <div>
            <span style="font-size: 1.2rem; margin-right: 0.5rem; display: inline-flex; align-items: center; vertical-align: middle; width: 20px; height: 20px; color: var(--gold); fill: currentColor;">
              ${evt.icon || '📅'}
            </span>
            <strong style="font-size: 1rem; color: #fff; margin-left: 0.5rem; vertical-align: middle;">${evt.label}</strong> 
            <code style="color: var(--gold); font-size: 0.8rem; margin-left: 0.5rem; background: rgba(212, 175, 55, 0.1); padding: 2px 6px; border-radius: 4px; vertical-align: middle;">${evt.key}</code>
            <div style="font-size: 0.8rem; color: var(--muted); margin-top: 0.25rem;">Sub-tabs: ${Array.isArray(evt.tabs) ? evt.tabs.join(', ') : evt.tabs}</div>
          </div>
          <div>
            ${deleteBtn}
          </div>
        </div>
      `;
    }).join('');

    listContainer.innerHTML = html;

    // Attach delete listeners
    if (!isFallback) {
      listContainer.querySelectorAll('.delete-evt-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const key = btn.dataset.key;
          if (!confirm(`Are you sure you want to delete the event type "${key}"? All packages linked to this event type will lose their categorisation.`)) return;

          const { error } = await window.supabaseClient
            .from('event_types')
            .delete()
            .eq('key', key);

          if (error) {
            alert('Failed to delete event type: ' + error.message);
          } else {
            loadEventTypes();
          }
        });
      });
    }
  }

  let eventTypeDebounceTimeout = null;

  function setupEventTypesRealtime() {
    if (!window.supabaseClient) return;
    
    // Clean up existing subscription if any to prevent duplicate channels
    try {
      window.supabaseClient.removeChannel(window.supabaseClient.channel('public:event_types_admin'));
    } catch (e) {
      console.warn("Failed to remove old channel:", e);
    }

    window.supabaseClient
      .channel('public:event_types_admin')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'event_types' }, () => {
        clearTimeout(eventTypeDebounceTimeout);
        eventTypeDebounceTimeout = setTimeout(() => {
          loadEventTypes();
        }, 150); // debounce database load
      })
      .subscribe();
  }

  const addEvtForm = document.getElementById('add-event-type-form');
  const evtIconPreset = document.getElementById('evt-icon-preset');
  const evtCustomIconGroup = document.getElementById('evt-custom-icon-group');
  const evtStatus = document.getElementById('event-type-status');

  if (evtIconPreset && evtCustomIconGroup) {
    evtIconPreset.addEventListener('change', () => {
      if (evtIconPreset.value === 'custom') {
        evtCustomIconGroup.classList.remove('hidden');
      } else {
        evtCustomIconGroup.classList.add('hidden');
      }
    });
  }

  if (addEvtForm) {
    addEvtForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const label = document.getElementById('evt-label').value.trim();
      const key = document.getElementById('evt-key').value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const tabsRaw = document.getElementById('evt-tabs').value;
      const preset = evtIconPreset.value;
      
      let icon = '';
      if (preset === 'custom') {
        icon = document.getElementById('evt-custom-icon').value.trim();
      } else {
        icon = ICON_PRESETS[preset] || ICON_PRESETS.star;
      }

      const tabs = tabsRaw.split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);

      if (!label || !key || tabs.length === 0) {
        alert('Please fill out all required fields.');
        return;
      }

      evtStatus.textContent = 'Saving event type...';
      
      try {
        const { error } = await window.supabaseClient
          .from('event_types')
          .insert([{ key, label, icon, tabs }]);

        if (error) {
          throw error;
        }

        evtStatus.textContent = '✅ Event type added successfully!';
        addEvtForm.reset();
        if (evtCustomIconGroup) evtCustomIconGroup.classList.add('hidden');
        setTimeout(() => evtStatus.textContent = '', 3000);
        loadEventTypes();
      } catch (err) {
        evtStatus.textContent = '❌ Error: ' + err.message;
        console.error(err);
      }
    });
  }

  // -----------------------------------------
  // ANNOUNCEMENT / POP-UP MANAGER
  // -----------------------------------------
  const annForm = document.getElementById('announcement-form');
  const annStatus = document.getElementById('ann-status');
  const annSaveBtn = document.getElementById('ann-save-btn');
  const annPreviewBtn = document.getElementById('ann-preview-btn');

  // Load existing announcement from Supabase
  async function loadAnnouncement() {
    try {
      const { data, error } = await window.supabaseClient
        .from('site_announcements')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') {
        console.warn('Could not load announcement:', error.message);
        return;
      }

      if (data) {
        document.getElementById('ann-enabled').checked = data.enabled ?? false;
        document.getElementById('ann-title').value = data.title || '';
        document.getElementById('ann-badge').value = data.badge || '';
        document.getElementById('ann-body').value = data.body || '';
        document.getElementById('ann-code').value = data.promo_code || '';
        document.getElementById('ann-cta').value = data.cta_text || '';
        document.getElementById('ann-link').value = data.cta_link || '';
      }
    } catch (err) {
      console.error('Error loading announcement:', err);
    }
  }

  // Helper to build the announcement data object from the form
  function getAnnouncementFormData() {
    return {
      enabled: document.getElementById('ann-enabled').checked,
      title: document.getElementById('ann-title').value.trim(),
      badge: document.getElementById('ann-badge').value.trim(),
      body: document.getElementById('ann-body').value.trim(),
      promo_code: document.getElementById('ann-code').value.trim().toUpperCase(),
      cta_text: document.getElementById('ann-cta').value.trim(),
      cta_link: document.getElementById('ann-link').value.trim(),
      updated_at: new Date().toISOString()
    };
  }

  if (annForm) {
    annForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      annSaveBtn.textContent = 'Saving...';
      annSaveBtn.disabled = true;
      annStatus.textContent = '';

      const payload = getAnnouncementFormData();

      try {
        // Check if a record exists
        const { data: existing, error: fetchErr } = await window.supabaseClient
          .from('site_announcements')
          .select('id')
          .limit(1)
          .maybeSingle();

        if (fetchErr && fetchErr.code !== 'PGRST116') throw fetchErr;

        let opError;
        if (existing) {
          const { error } = await window.supabaseClient
            .from('site_announcements')
            .update(payload)
            .eq('id', existing.id);
          opError = error;
        } else {
          const { error } = await window.supabaseClient
            .from('site_announcements')
            .insert([payload]);
          opError = error;
        }

        if (opError) throw opError;

        annStatus.textContent = payload.enabled
          ? '✅ Announcement saved and is now LIVE on your website!'
          : '✅ Announcement saved (currently disabled — visitors won\'t see it).';
        setTimeout(() => annStatus.textContent = '', 5000);
      } catch (err) {
        annStatus.textContent = '❌ Error saving: ' + err.message;
        console.error(err);
      } finally {
        annSaveBtn.textContent = 'Save Announcement';
        annSaveBtn.disabled = false;
      }
    });
  }

  // Preview button — shows the pop-up on this admin page for testing
  if (annPreviewBtn) {
    annPreviewBtn.addEventListener('click', () => {
      const data = getAnnouncementFormData();
      showAnnouncementPopup(data, true);
    });
  }

  // Shared function to render and show the announcement popup
  function showAnnouncementPopup(data, isPreview = false) {
    // Remove any existing popup
    const existing = document.getElementById('sc-announcement-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'sc-announcement-overlay';
    overlay.innerHTML = `
      <div class="sc-ann-modal" role="dialog" aria-modal="true" aria-labelledby="sc-ann-title">
        <button class="sc-ann-close" id="sc-ann-close-btn" aria-label="Close announcement">&times;</button>
        ${isPreview ? '<div class="sc-ann-preview-badge">🔍 Preview Mode</div>' : ''}
        ${data.badge ? `<div class="sc-ann-badge">${data.badge}</div>` : ''}
        ${data.title ? `<h2 class="sc-ann-title" id="sc-ann-title">${data.title}</h2>` : ''}
        ${data.body ? `<p class="sc-ann-body">${data.body.replace(/\n/g, '<br>')}</p>` : ''}
        ${data.promo_code ? `
          <div class="sc-ann-code-wrap">
            <span class="sc-ann-code-label">Your promo code</span>
            <div class="sc-ann-code" id="sc-ann-promo-code">${data.promo_code}</div>
            <button class="sc-ann-copy-btn" id="sc-ann-copy-btn" onclick="
              navigator.clipboard.writeText('${data.promo_code}');
              this.textContent = '✓ Copied!';
              setTimeout(() => this.textContent = 'Copy Code', 1500);
            ">Copy Code</button>
          </div>
        ` : ''}
        ${(data.cta_text && data.cta_link) ? `
          <a href="${data.cta_link}" target="_blank" rel="noopener noreferrer" class="sc-ann-cta-btn">${data.cta_text}</a>
        ` : ''}
        <button class="sc-ann-dismiss-btn" id="sc-ann-dismiss-btn">Maybe later</button>
      </div>
    `;

    document.body.appendChild(overlay);

    // Trigger animation
    requestAnimationFrame(() => overlay.classList.add('sc-ann-visible'));

    const close = () => {
      overlay.classList.remove('sc-ann-visible');
      setTimeout(() => overlay.remove(), 380);
    };

    document.getElementById('sc-ann-close-btn').addEventListener('click', close);
    document.getElementById('sc-ann-dismiss-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  }

  // Load announcement when settings tab is opened (or when logged in)
  // We hook into tab click to lazy-load
  document.querySelectorAll('.admin-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.target === 'announcement') {
        loadAnnouncement();
      }
    });
  });

});

