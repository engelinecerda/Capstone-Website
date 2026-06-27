// app.js
const menuToggle = document.getElementById('mobile-menu');
const menu = document.querySelector('.navbar__menu');
const navOverlay = document.getElementById('nav-drawer-overlay');
const drawerClose = document.getElementById('nav-drawer-close');

function openDrawer() {
    menu.classList.add('active');
    navOverlay.classList.add('active');
    document.documentElement.classList.add('nav-open');
    document.body.classList.add('nav-open');
}

function closeDrawer() {
    menu.classList.remove('active');
    navOverlay.classList.remove('active');
    document.documentElement.classList.remove('nav-open');
    document.body.classList.remove('nav-open');
}

if (menuToggle) menuToggle.addEventListener('click', openDrawer);
if (navOverlay) navOverlay.addEventListener('click', closeDrawer);
if (drawerClose) drawerClose.addEventListener('click', closeDrawer);

// Close on Escape key
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && menu && menu.classList.contains('active')) {
        closeDrawer();
    }
});

// Close drawer and clear scroll lock when viewport widens past the mobile breakpoint
window.addEventListener('resize', function () {
    if (window.innerWidth > 960 && menu && menu.classList.contains('active')) {
        closeDrawer();
    }
});

// Select all cards and modals
const cards = document.querySelectorAll('.card');
const modals = document.querySelectorAll('.modal');

// Open modal when card is clicked
cards.forEach(card => {
    card.addEventListener('click', () => {
        const modalId = card.getAttribute('data-modal');
        const modal = document.getElementById(modalId);
        if (modal) modal.style.display = 'block';
    });
});

// Close modal when clicking the close button
const closeBtns = document.querySelectorAll('.close-btn');
closeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        btn.closest('.modal').style.display = 'none';
    });
});

// Close modal when clicking outside modal content
window.addEventListener('click', (e) => {
    modals.forEach(modal => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });
});
