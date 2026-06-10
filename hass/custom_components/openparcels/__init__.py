"""The OpenParcels integration."""
from __future__ import annotations

import logging
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, Event

DOMAIN = "openparcels"
_LOGGER = logging.getLogger(__name__)

async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up OpenParcels from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    # Register an event listener for openparcels events
    async def handle_openparcels_event(event: Event):
        """Handle incoming OpenParcels events and update sensors/calendars (to be implemented)."""
        _LOGGER.info("Received OpenParcels event: %s", event.data)
        
    hass.bus.async_listen("openparcels_update", handle_openparcels_event)
    
    _LOGGER.info("OpenParcels integration setup complete")
    return True

async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    _LOGGER.info("OpenParcels integration unloaded")
    return True
