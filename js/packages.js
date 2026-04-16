const openModal = (modal) => {
    if (!modal) {
        return;
    }

    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    resetPackageDetailModal(modal);
};

const closeModal = (modal) => {
    if (!modal) {
        return;
    }

    modal.style.display = 'none';
    document.body.style.overflow = '';
};

const setActivePackageTab = (modal, tabName) => {
    const tabs = modal.querySelectorAll('.package-tab');
    const panels = modal.querySelectorAll('.package-panel');

    tabs.forEach((tab) => {
        const isActive = tab.dataset.packageTab === tabName;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    panels.forEach((panel) => {
        const isActive = panel.dataset.packagePanel === tabName;
        panel.classList.toggle('is-active', isActive);

        if (isActive) {
            panel.removeAttribute('hidden');
        } else {
            panel.setAttribute('hidden', '');
        }
    });
};

const resetTierCards = (modal) => {
    modal.querySelectorAll('.package-tier-toggle').forEach((button) => {
        button.setAttribute('aria-expanded', 'false');
        button.textContent = 'View full inclusions';
    });

    modal.querySelectorAll('.package-tier-extra').forEach((extra) => {
        extra.setAttribute('hidden', '');
    });
};

const resetPackageDetailModal = (modal) => {
    if (!modal.querySelector('.package-tab')) {
        return;
    }

    setActivePackageTab(modal, 'overview');
    resetTierCards(modal);
};

document.querySelectorAll('.card[data-modal]').forEach((card) => {
    card.addEventListener('click', () => {
        const modalId = card.getAttribute('data-modal');
        const modal = document.getElementById(modalId);
        openModal(modal);
    });
});

document.querySelectorAll('.close-btn').forEach((button) => {
    button.addEventListener('click', () => {
        closeModal(button.closest('.modal'));
    });
});

window.addEventListener('click', (event) => {
    if (event.target.classList.contains('modal')) {
        closeModal(event.target);
    }
});

window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
        return;
    }

    const openPackage = document.querySelector('.modal[style*="display: flex"]');
    closeModal(openPackage);
});

document.querySelectorAll('.package-detail-modal').forEach((modalContent) => {
    const modal = modalContent.closest('.modal');

    modalContent.querySelectorAll('.package-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            setActivePackageTab(modal, tab.dataset.packageTab);
        });
    });

    modalContent.querySelectorAll('.package-tier-toggle').forEach((button) => {
        button.addEventListener('click', () => {
            const expanded = button.getAttribute('aria-expanded') === 'true';
            const extra = button.nextElementSibling;

            button.setAttribute('aria-expanded', expanded ? 'false' : 'true');
            button.textContent = expanded ? 'View full inclusions' : 'Hide full inclusions';

            if (extra) {
                if (expanded) {
                    extra.setAttribute('hidden', '');
                } else {
                    extra.removeAttribute('hidden');
                }
            }
        });
    });
});
