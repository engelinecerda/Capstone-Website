// faqs_content.js — wires faqs.html's hero and FAQ accordion to Page
// Content. Also owns the accordion open/close wiring (moved out of the
// inline <script> that used to live at the bottom of faqs.html — that
// script ran once at page load against static markup, which no longer
// works now the list is rendered dynamically after an async fetch).
import { customerSupabase as supabase } from './supabase.js';
import { loadPageHeader, loadFaqs } from './page_content.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function wireAccordion(wrapper) {
  wrapper.querySelectorAll('.faq-header').forEach(header => {
    header.addEventListener('click', () => {
      const faq = header.parentElement;
      const isOpen = faq.classList.contains('active');
      wrapper.querySelectorAll('.faq.active').forEach(f => f.classList.remove('active'));
      if (!isOpen) faq.classList.add('active');
    });
  });
}

async function initFaqs() {
  const wrapper = document.querySelector('.faq-section .wrapper');
  if (!wrapper) return;

  const faqs = await loadFaqs(supabase);
  if (!faqs.length) { wireAccordion(wrapper); return; } // keep hardcoded fallback, still wire it up

  wrapper.innerHTML = faqs.map(f => `
    <div class="faq">
      <button class="faq-header">
        ${escapeHtml(f.question)}
        <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
      </button>
      <div class="faq-body">
        <p>${escapeHtml(f.answer)}</p>
      </div>
    </div>`).join('');

  wireAccordion(wrapper);
}

loadPageHeader(supabase, 'faqs', {
  imgEl: document.querySelector('.page-hero-img'),
  headingEl: document.querySelector('.page-hero-title'),
  subEl: document.querySelector('.page-hero-sub')
}, 1920);
initFaqs();
