import os
import sys
import importlib.util


def _load_production_dbclient():
    """Import the production DBClient from ../clients/dbClient.py.

    design.md: "dbClient (TEST) is the same as the normal dbClient." Rather
    than duplicate the SQL, we load the production module directly and reuse
    its DBClient. It still calls the API server using SIM_API_* env vars
    (point them at a local/tunnelled test database)."""
    here = os.path.dirname(os.path.abspath(__file__))
    prod_path = os.path.join(here, '..', 'clients', 'dbClient.py')
    prod_path = os.path.abspath(prod_path)

    spec = importlib.util.spec_from_file_location('prod_dbClient', prod_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules['prod_dbClient'] = module
    spec.loader.exec_module(module)
    return module.DBClient


class DBClient(_load_production_dbclient()):
    """Test DB client. Identical behaviour to the production client (per
    design.md); exists as a separate symbol so RUNNING_MODE=test resolves it
    from ./testClients while keeping the implementation in one place."""
    pass
