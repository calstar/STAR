def pytest_configure(config):
    config.addinivalue_line("markers", "slow: runs a second or more of air time (minutes)")
