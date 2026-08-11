import pytest

from core.config import settings
from core.database import init_db


@pytest.fixture()
def temp_db(tmp_path):
    """Point the app's SQLite DB at a fresh temp dir and initialise the schema."""
    prev = settings.config_dir
    settings.config_dir = tmp_path
    init_db()
    try:
        yield tmp_path
    finally:
        settings.config_dir = prev
