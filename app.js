const menuToggle = document.getElementById('mobile-menu');
const menu = document.querySelector('.navbar__menu');

menuToggle.addEventListener('click', function() {
    menu.classList.toggle('active');
});