/**
 * YouTube Scroll Enhancer - Content Script
 */

let commentsOriginalParent = null;
let commentsElement = null;
let isEnhanced = false;

// Settings State
let settingsCache = {
  isEnabled: true,
  isPinEnabled: true,
  language: 'ja'
};
let isSettingsLoaded = false;

// Cleanup any zombie elements from a previous extension context (if user reloaded extension without refreshing page)
document.querySelectorAll('.yt-scroll-enhancer-pin-btn').forEach(btn => btn.remove());
document.querySelectorAll('[data-pin-injected]').forEach(el => el.removeAttribute('data-pin-injected'));

// i18n Dictionary for tooltips
const i18n = {
  ja: { videos: '関連動画', comments: 'コメント' },
  en: { videos: 'Related Videos', comments: 'Comments' },
  fr: { videos: 'Vidéos similaires', comments: 'Commentaires' },
  zh: { videos: '相关视频', comments: '评论' }
};

/**
 * Helper: Wait for an element to appear in the DOM
 */
function waitForEl(selector, parent = document) {
  return new Promise((resolve) => {
    const el = parent.querySelector(selector);
    if (el) {
      return resolve(el);
    }
    const observer = new MutationObserver(() => {
      const el = parent.querySelector(selector);
      if (el) {
        resolve(el);
        observer.disconnect();
      }
    });
    observer.observe(parent, {
      childList: true,
      subtree: true,
    });
  });
}

/**
 * Emulates scroll/resize events to trigger YouTube's comment lazy loader
 */
function triggerCommentsLoad(comments) {
  setTimeout(() => {
    // 1. Dispatch global scroll and resize events
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));

    // 2. Dispatch scroll event specifically on the secondary scroll container
    const secondary = document.getElementById('secondary');
    if (secondary) {
      secondary.dispatchEvent(new Event('scroll'));
    }

    // 3. Dispatch visibility events to the comments component
    const ytdComments = comments.querySelector('ytd-comments');
    if (ytdComments) {
      ytdComments.dispatchEvent(new CustomEvent('visible'));
      // Trigger inner elements as well
      const commentRenderer = ytdComments.querySelector('ytd-item-section-renderer');
      if (commentRenderer) {
        commentRenderer.dispatchEvent(new Event('scroll'));
      }
    }
  }, 150);
}

/**
 * Set up the Custom Tabs UI in the secondary column
 */
function setupSidebarUI(secondary, lang = 'ja') {
  const dict = i18n[lang] || i18n['ja'];

  let switcher = secondary.querySelector('.yt-scroll-switcher');
  if (switcher) {
    switcher.remove();
  }

  // Create switcher container
  switcher = document.createElement('div');
  switcher.className = 'yt-scroll-switcher';
  switcher.setAttribute('data-active-tab', 'videos');

  // Slider background indicator
  const indicator = document.createElement('div');
  indicator.className = 'yt-scroll-switcher-indicator';
  switcher.appendChild(indicator);

  // "Videos" Tab Button
  const videoBtn = document.createElement('button');
  videoBtn.className = 'yt-scroll-switcher-btn active';
  videoBtn.setAttribute('data-tab', 'videos');
  videoBtn.title = dict.videos;
  // Standard video library/playlist icon
  videoBtn.innerHTML = `
    <svg viewBox="0 0 24 24">
      <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12zm-8-2.5l6-3.5-6-3.5v7z"/>
    </svg>
  `;

  // "Comments" Tab Button
  const commentBtn = document.createElement('button');
  commentBtn.className = 'yt-scroll-switcher-btn';
  commentBtn.setAttribute('data-tab', 'comments');
  commentBtn.title = dict.comments;
  // Chat bubble icon
  commentBtn.innerHTML = `
    <svg viewBox="0 0 24 24">
      <path d="M21.99 4c0-1.1-.89-2-1.99-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4-.01-18zM18 14H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/>
    </svg>
  `;

  switcher.appendChild(videoBtn);
  switcher.appendChild(commentBtn);

  // Insert switcher at the top of secondary-inner
  const secondaryInner = secondary.querySelector('#secondary-inner');
  if (secondaryInner) {
    secondaryInner.insertBefore(switcher, secondaryInner.firstChild);
  } else {
    secondary.insertBefore(switcher, secondary.firstChild);
  }

  // Add scroll listener to make switcher transparent when scrolled over videos
  secondary.addEventListener('scroll', () => {
    if (secondary.scrollTop > 5) {
      switcher.classList.add('is-scrolled');
    } else {
      switcher.classList.remove('is-scrolled');
    }
  });

  // Store scroll positions for each tab
  const scrollState = {
    videos: 0,
    comments: 0
  };

  // Set default active tab
  secondary.setAttribute('data-active-tab', 'videos');

  // Add click handlers
  const buttons = [videoBtn, commentBtn];
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      // Ignore if clicking already active tab
      if (btn.classList.contains('active')) return;

      // Save scroll position of current tab
      const currentTab = switcher.getAttribute('data-active-tab');
      if (currentTab) {
        scrollState[currentTab] = secondary.scrollTop;
      }

      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      const tabName = btn.getAttribute('data-tab');
      switcher.setAttribute('data-active-tab', tabName);
      secondary.setAttribute('data-active-tab', tabName);

      // Restore scroll position of new tab
      secondary.scrollTo({ top: scrollState[tabName] || 0, behavior: 'instant' });

      if (tabName === 'comments') {
        if (commentsElement) triggerCommentsLoad(commentsElement);
      }
    });
  });
}

/**
 * Initializes scroll enhancement layout and elements
 */
function initEnhancer() {
  // If already initialized, clean up first to avoid duplicated tabs or orphaned comments
  cleanupEnhancer();

  if (window.location.pathname !== '/watch') {
    return;
  }

  isEnhanced = true;
  document.documentElement.setAttribute('scroll-enhanced', '');

  // Wait for critical elements asynchronously (excluding comments which are lazy-loaded)
  Promise.all([
    waitForEl('ytd-watch-flexy'),
    waitForEl('#secondary'),
    waitForEl('#primary-inner')
  ]).then(([watchFlexy, secondary, primaryInner]) => {
    // Re-verify state and path to prevent injection during mid-navigation or after cleanup
    if (!isEnhanced || window.location.pathname !== '/watch') {
      return;
    }

    // Apply attribute for CSS triggers
    watchFlexy.setAttribute('scroll-enhanced', '');

    // Set up the sidebar tabs immediately
    setupSidebarUI(secondary, settingsCache.language);

    // Completely eliminate scroll "play" before sticky kicks in by locking exact initial position
    requestAnimationFrame(() => {
      if (window.scrollY < 20) {
        const rect = secondary.getBoundingClientRect();
        const initialTop = Math.max(Math.round(rect.top), 56);
        secondary.style.setProperty('top', `${initialTop}px`, 'important');
        secondary.style.setProperty('height', `calc(100vh - ${initialTop}px)`, 'important');
      } else {
        secondary.style.setProperty('top', `80px`, 'important');
        secondary.style.setProperty('height', `calc(100vh - 80px)`, 'important');
      }
    });

    // Wait for comments independently since YouTube lazy-loads them
    waitForEl('#comments').then((comments) => {
      if (window.location.pathname !== '/watch' || !isEnhanced) return;

      commentsElement = comments;

      // Save original parent
      if (
        comments.parentElement &&
        comments.parentElement.id !== 'secondary-inner' &&
        comments.parentElement.id !== 'secondary'
      ) {
        commentsOriginalParent = comments.parentElement;
      }

      // Move comments to secondary column
      const secondaryInner = secondary.querySelector('#secondary-inner');
      if (secondaryInner) {
        secondaryInner.appendChild(comments);
      } else {
        secondary.appendChild(comments);
      }
    });
  });
}

/**
 * Resets the DOM layout back to YouTube defaults
 */
function cleanupEnhancer() {
  isEnhanced = false;
  document.documentElement.removeAttribute('scroll-enhanced');

  const watchFlexy = document.querySelector('ytd-watch-flexy');
  if (watchFlexy) {
    watchFlexy.removeAttribute('scroll-enhanced');
  }

  const secondary = document.getElementById('secondary');
  if (secondary) {
    secondary.removeAttribute('data-active-tab');
    secondary.style.removeProperty('top');
    secondary.style.removeProperty('height');
    const switcher = secondary.querySelector('.yt-scroll-switcher');
    if (switcher) {
      switcher.remove();
    }
  }

  // Safely restore comments back to original primary column position
  if (commentsElement && commentsOriginalParent) {
    // Check if it's already there to prevent infinite loop or unnecessary DOM churn
    if (commentsElement.parentElement !== commentsOriginalParent) {
      commentsOriginalParent.appendChild(commentsElement);
    }
  }
}

/**
 * Watch for YouTube SPF Navigation Events
 */
// Emitted when user initiates navigation. Safely restore comments to prevent YouTube's routing from breaking.
window.addEventListener('yt-navigate-start', () => {
  if (commentsElement && commentsOriginalParent) {
    commentsOriginalParent.appendChild(commentsElement);
  }
  
  // Dismiss pinned comment when navigating to a new video
  if (typeof pinnedContainer !== 'undefined' && pinnedContainer) {
    const body = pinnedContainer.querySelector('.yt-scroll-enhancer-pinned-body');
    if (body) body.innerHTML = '';
    pinnedContainer.style.display = 'none';
    pinnedContainer.classList.add('is-collapsed');
  }
});

// --- Core State Management & Polling ---

function evaluateEnhancerState() {
  if (!isSettingsLoaded) return;
  
  if (settingsCache.isEnabled && window.location.pathname === '/watch') {
    // ユーザーからの要望によるワークアラウンド：
    // 初回ロード時にYouTube側の強力なSPAキャッシュ等でUIが適用されない問題を解決するため、
    // このタブで初めて動画ページを開いた際に1度だけ強制リロードを挟む。
    if (!sessionStorage.getItem('yt_enhancer_force_reloaded')) {
      sessionStorage.setItem('yt_enhancer_force_reloaded', 'true');
      window.location.reload();
      return;
    }
    
    initEnhancer();
  } else {
    cleanupEnhancer();
  }
}

// Immediately fetch settings once
if (typeof chrome !== 'undefined' && chrome.storage) {
  chrome.storage.local.get(['isEnabled', 'isPinEnabled', 'language'], (result) => {
    settingsCache.isEnabled = result.isEnabled !== false;
    settingsCache.isPinEnabled = result.isPinEnabled !== false;
    settingsCache.language = result.language || 'ja';
    isSettingsLoaded = true;
    
    if (document.readyState !== 'loading') {
      evaluateEnhancerState();
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    let requiresRebuild = false;
    
    if (changes.isEnabled) {
      settingsCache.isEnabled = changes.isEnabled.newValue;
      requiresRebuild = true;
    }
    if (changes.language) {
      settingsCache.language = changes.language.newValue;
      requiresRebuild = true;
    }
    
    if (changes.isPinEnabled) {
      settingsCache.isPinEnabled = changes.isPinEnabled.newValue;
      if (typeof togglePinFeature === 'function') togglePinFeature(settingsCache.isPinEnabled);
    }
    
    if (requiresRebuild) {
      evaluateEnhancerState();
    }
  });
} else {
  isSettingsLoaded = true;
}

// 1. YouTube-specific events (covers SPA navigation)
window.addEventListener('yt-navigate-finish', evaluateEnhancerState);
window.addEventListener('yt-page-data-updated', evaluateEnhancerState);

// 2. Standard DOM events
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', evaluateEnhancerState);
} else {
  evaluateEnhancerState();
}

// 3. Fail-safe polling (catch-all for lazy rendering or missed events)
setInterval(() => {
  if (
    isSettingsLoaded &&
    settingsCache.isEnabled &&
    window.location.pathname === '/watch' &&
    !document.querySelector('ytd-watch-flexy[scroll-enhanced]')
  ) {
    evaluateEnhancerState();
  }
}, 1000);

// --- Comment Pinning Feature ---

const pinIconSVG = `<svg viewBox="0 0 24 24"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>`;
const unpinIconSVG = `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
const chevronIconSVG = `<svg viewBox="0 0 24 24"><path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z"/></svg>`;

const jumpIconSVG = `<svg viewBox="0 0 24 24"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>`;

const pinI18n = {
  ja: { pinBtn: 'コメントをピン留め', pinnedTitle: 'ピン留めされたコメント', jumpBtn: 'コメントに飛ぶ' },
  en: { pinBtn: 'Pin comment', pinnedTitle: 'Pinned Comment', jumpBtn: 'Jump to comment' },
  fr: { pinBtn: 'Épingler le commentaire', pinnedTitle: 'Commentaire épinglé', jumpBtn: 'Aller au commentaire' },
  zh: { pinBtn: '固定评论', pinnedTitle: '已固定的评论', jumpBtn: '跳转到评论' }
};

let pinnedContainer = null;
let secondaryResizeObserver = null;

function setupPinnedContainer() {
  if (pinnedContainer) return;

  pinnedContainer = document.createElement('div');
  pinnedContainer.className = 'yt-scroll-enhancer-pinned-container is-collapsed';
  pinnedContainer.style.display = 'none';
  pinnedContainer.style.position = 'fixed';

  const header = document.createElement('div');
  header.className = 'yt-scroll-enhancer-pinned-header';

  const title = document.createElement('div');
  title.className = 'yt-scroll-enhancer-pinned-title';
  const lang = settingsCache.language || 'ja';
  const dict = pinI18n[lang] || pinI18n['ja'];
  title.innerHTML = `${pinIconSVG} <span class="yt-scroll-enhancer-pinned-title-text">${dict.pinnedTitle}</span>`;

  const actions = document.createElement('div');
  actions.className = 'yt-scroll-enhancer-pinned-actions';

  const collapseBtn = document.createElement('button');
  collapseBtn.className = 'yt-scroll-enhancer-action-btn yt-scroll-enhancer-chevron';
  collapseBtn.innerHTML = chevronIconSVG;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'yt-scroll-enhancer-action-btn';
  closeBtn.innerHTML = unpinIconSVG;

  actions.appendChild(collapseBtn);
  actions.appendChild(closeBtn);
  header.appendChild(title);
  header.appendChild(actions);

  const body = document.createElement('div');
  body.className = 'yt-scroll-enhancer-pinned-body';

  pinnedContainer.appendChild(header);
  pinnedContainer.appendChild(body);
  document.body.appendChild(pinnedContainer);

  header.addEventListener('click', (e) => {
    if (e.target.closest('.yt-scroll-enhancer-action-btn') === closeBtn) return;
    pinnedContainer.classList.toggle('is-collapsed');
  });

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    body.innerHTML = '';
    pinnedContainer.style.display = 'none';
    pinnedContainer.classList.add('is-collapsed');
  });

  secondaryResizeObserver = new ResizeObserver(() => {
    const secondary = document.getElementById('secondary');
    if (secondary && pinnedContainer.style.display !== 'none') {
      const rect = secondary.getBoundingClientRect();
      pinnedContainer.style.right = (window.innerWidth - rect.right + 16) + 'px';
      pinnedContainer.style.width = (rect.width - 32) + 'px';
    }
  });
}

function injectPinButtons() {
  const comments = document.querySelectorAll('ytd-comment-renderer:not([data-pin-injected]), ytd-comment-view-model:not([data-pin-injected])');
  const lang = settingsCache.language || 'ja';
  const dict = pinI18n[lang] || pinI18n['ja'];

  comments.forEach(comment => {
    comment.setAttribute('data-pin-injected', 'true');
    const btn = document.createElement('button');
    btn.className = 'yt-scroll-enhancer-pin-btn';
    btn.title = dict.pinBtn;
    btn.innerHTML = pinIconSVG;
    
    const body = comment.querySelector('#body') || comment.querySelector('#main') || comment;
    body.appendChild(btn);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      pinComment(comment);
    });
  });
}

function pinComment(originalComment) {
  setupPinnedContainer();
  if (!pinnedContainer) return;

  const body = pinnedContainer.querySelector('.yt-scroll-enhancer-pinned-body');
  body.innerHTML = ''; 

  const clone = originalComment.cloneNode(true);
  
  const injectedBtn = clone.querySelector('.yt-scroll-enhancer-pin-btn');
  if (injectedBtn) injectedBtn.remove();

  clone.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (a) {
      e.preventDefault();
      e.stopPropagation();
      if (a.href && a.href.includes('&t=')) {
        const url = new URL(a.href);
        const t = url.searchParams.get('t');
        if (t) {
          const seconds = parseInt(t.replace('s', ''), 10);
          const video = document.querySelector('video');
          if (video && !isNaN(seconds)) {
            video.currentTime = seconds;
            video.play();
          }
        }
      }
    }
  });
  
  body.appendChild(clone);

  // Add Jump Button
  const lang = settingsCache.language || 'ja';
  const dict = pinI18n[lang] || pinI18n['ja'];
  
  const jumpContainer = document.createElement('div');
  jumpContainer.className = 'yt-scroll-enhancer-jump-container';
  
  const jumpBtn = document.createElement('button');
  jumpBtn.className = 'yt-scroll-enhancer-jump-btn';
  jumpBtn.innerHTML = `<span>${dict.jumpBtn}</span> ${jumpIconSVG}`;
  
  jumpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    
    // Switch to comments tab if currently on videos tab
    const secondary = document.getElementById('secondary');
    if (secondary && secondary.getAttribute('data-active-tab') !== 'comments') {
      const commentBtn = secondary.querySelector('.yt-scroll-switcher-btn[data-tab="comments"]');
      if (commentBtn) commentBtn.click();
    }
    
    // Use requestAnimationFrame to ensure the tab has switched and layout is updated before scrolling
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (secondary) {
          const commentRect = originalComment.getBoundingClientRect();
          const secondaryRect = secondary.getBoundingClientRect();
          const targetScrollTop = secondary.scrollTop + (commentRect.top - secondaryRect.top) - (secondaryRect.height / 2) + (commentRect.height / 2);
          
          secondary.scrollTo({
            top: targetScrollTop,
            behavior: 'smooth'
          });
        }
        
        // Highlight the original comment momentarily (White color)
        const originalBg = originalComment.style.backgroundColor;
        const originalTransition = originalComment.style.transition;
        originalComment.style.transition = 'background-color 0.5s ease';
        originalComment.style.backgroundColor = 'rgba(255, 255, 255, 0.15)';
        
        setTimeout(() => {
          originalComment.style.backgroundColor = originalBg;
          setTimeout(() => {
            originalComment.style.transition = originalTransition;
          }, 500);
        }, 1500);
      });
    });
  });
  
  jumpContainer.appendChild(jumpBtn);
  body.appendChild(jumpContainer);
  
  const secondary = document.getElementById('secondary');
  if (secondary) {
    secondaryResizeObserver.observe(secondary);
    const rect = secondary.getBoundingClientRect();
    pinnedContainer.style.right = (window.innerWidth - rect.right + 16) + 'px';
    pinnedContainer.style.width = (rect.width - 32) + 'px';
  }

  pinnedContainer.style.display = 'flex';
  setTimeout(() => {
    pinnedContainer.classList.remove('is-collapsed');
  }, 10);
}

function togglePinFeature(enable) {
  if (!enable) {
    if (pinnedContainer) {
      pinnedContainer.style.display = 'none';
      const body = pinnedContainer.querySelector('.yt-scroll-enhancer-pinned-body');
      if (body) body.innerHTML = '';
      pinnedContainer.classList.add('is-collapsed');
    }
    document.querySelectorAll('.yt-scroll-enhancer-pin-btn').forEach(btn => btn.remove());
    document.querySelectorAll('ytd-comment-renderer[data-pin-injected], ytd-comment-view-model[data-pin-injected]').forEach(el => {
      el.removeAttribute('data-pin-injected');
    });
  } else {
    // Container title language update just in case language changed while disabled
    if (pinnedContainer) {
      const titleText = pinnedContainer.querySelector('.yt-scroll-enhancer-pinned-title-text');
      if (titleText) {
        const lang = settingsCache.language || 'ja';
        const dict = pinI18n[lang] || pinI18n['ja'];
        titleText.textContent = dict.pinnedTitle;
      }
    }
  }
}

setInterval(() => {
  if (isEnhanced && settingsCache.isPinEnabled) {
    setupPinnedContainer();
    injectPinButtons();
  } else if (!settingsCache.isPinEnabled && pinnedContainer && pinnedContainer.style.display !== 'none') {
    togglePinFeature(false);
  }
}, 1000);
