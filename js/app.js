// app.js
const menuToggle = document.getElementById('mobile-menu');
const menu = document.querySelector('.navbar__menu');

menuToggle.addEventListener('click', function() {
    menu.classList.toggle('active');
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