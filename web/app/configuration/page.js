'use client';
import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Card, Table, Notice, Tabs, useForm, Field } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtQty } from '@/lib/format';

export default function ConfigurationPage() {
  return <Shell><Config /></Shell>;
}

function Config() {
  const [tab, setTab] = useState('fuel');
  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'fuel', label: 'Fuel types' },
          { value: 'tanks', label: 'Tanks' },
          { value: 'pumps', label: 'Pumps' },
        ]}
      />
      {tab === 'fuel' && <FuelTypes />}
      {tab === 'tanks' && <Tanks />}
      {tab === 'pumps' && <Pumps />}
    </>
  );
}

function FuelTypes() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { form, bind, setForm } = useForm({ name: '', code: '', unit: 'L' });
  const load = useCallback(() => api('/api/fuel-types').then((r) => setRows(r.fuel_types)).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  async function submit(e) {
    e.preventDefault();
    try {
      await api('/api/fuel-types', { method: 'POST', body: form });
      setNotice(`Fuel type ${form.name} added.`);
      setForm({ name: '', code: '', unit: 'L' });
      load();
    } catch (e) { setError(e.message); }
  }

  return (
    <>
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}
      <Card title="Add fuel type">
        <form onSubmit={submit} className="grid c3">
          <Field label="Name *"><input {...bind('name')} required placeholder="Diesel" /></Field>
          <Field label="Code *"><input {...bind('code')} required placeholder="DIESEL" style={{ textTransform: 'uppercase' }} /></Field>
          <Field label="Unit"><input {...bind('unit')} /></Field>
          <div><button className="btn">Add</button></div>
        </form>
      </Card>
      <Card title="Fuel types">
        <Table
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'code', label: 'Code' },
            { key: 'unit', label: 'Unit' },
            { key: 'active', label: 'Status', render: (r) => r.active ? 'Active' : 'Inactive' },
          ]}
          rows={rows}
        />
      </Card>
    </>
  );
}

function Tanks() {
  const [rows, setRows] = useState([]);
  const [fuels, setFuels] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { form, bind, setForm } = useForm({ name: '', fuel_type_id: '', capacity: '', location: '', opening_quantity: '' });
  const load = useCallback(async () => {
    try {
      const [t, f] = await Promise.all([api('/api/tanks'), api('/api/fuel-types')]);
      setRows(t.tanks); setFuels(f.fuel_types);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function submit(e) {
    e.preventDefault();
    try {
      await api('/api/tanks', {
        method: 'POST',
        body: {
          ...form,
          capacity: Number(form.capacity),
          opening_quantity: form.opening_quantity === '' ? undefined : Number(form.opening_quantity),
        },
      });
      setNotice(`Tank ${form.name} created.${form.opening_quantity ? ' Opening stock posted to the ledger.' : ''}`);
      setForm({ name: '', fuel_type_id: '', capacity: '', location: '', opening_quantity: '' });
      load();
    } catch (e) { setError(e.message); }
  }

  return (
    <>
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}
      <Card title="Add tank">
        <form onSubmit={submit} className="grid c3">
          <Field label="Name *"><input {...bind('name')} required placeholder="Main Diesel Tank" /></Field>
          <Field label="Fuel type *">
            <select {...bind('fuel_type_id')} required>
              <option value="">Select…</option>
              {fuels.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Field>
          <Field label="Capacity (L) *"><input type="number" step="0.01" min="1" {...bind('capacity')} required /></Field>
          <Field label="Location"><input {...bind('location')} /></Field>
          <Field label="Opening stock (L)"><input type="number" step="0.01" min="0" {...bind('opening_quantity')} placeholder="0" /></Field>
          <div><button className="btn">Create tank</button></div>
        </form>
      </Card>
      <Card title="Tanks">
        <Table
          columns={[
            { key: 'name', label: 'Tank' },
            { key: 'fuel_type_name', label: 'Fuel' },
            { key: 'capacity', label: 'Capacity', num: true, render: (r) => fmtQty(r.capacity) },
            { key: 'location', label: 'Location', render: (r) => r.location || '—' },
            { key: 'active', label: 'Status', render: (r) => r.active ? 'Active' : 'Inactive' },
          ]}
          rows={rows}
        />
      </Card>
    </>
  );
}

function Pumps() {
  const [rows, setRows] = useState([]);
  const [tanks, setTanks] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { form, bind, setForm } = useForm({ name: '', tank_id: '', serial: '' });
  const load = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([api('/api/pumps'), api('/api/tanks')]);
      setRows(p.pumps); setTanks(t.tanks);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function submit(e) {
    e.preventDefault();
    try {
      await api('/api/pumps', { method: 'POST', body: form });
      setNotice(`Pump ${form.name} added.`);
      setForm({ name: '', tank_id: '', serial: '' });
      load();
    } catch (e) { setError(e.message); }
  }

  return (
    <>
      {error && <Notice kind="error" onDone={() => setError('')}>{error}</Notice>}
      {notice && <Notice kind="success" onDone={() => setNotice('')}>{notice}</Notice>}
      <Card title="Add pump">
        <form onSubmit={submit} className="grid c3">
          <Field label="Name *"><input {...bind('name')} required placeholder="Pump 1" /></Field>
          <Field label="Tank *">
            <select {...bind('tank_id')} required>
              <option value="">Select…</option>
              {tanks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Serial"><input {...bind('serial')} /></Field>
          <div><button className="btn">Add pump</button></div>
        </form>
      </Card>
      <Card title="Pumps">
        <Table
          columns={[
            { key: 'name', label: 'Pump' },
            { key: 'tank_name', label: 'Tank' },
            { key: 'fuel_type_name', label: 'Fuel' },
            { key: 'serial', label: 'Serial', render: (r) => r.serial || '—' },
            { key: 'active', label: 'Status', render: (r) => r.active ? 'Active' : 'Inactive' },
          ]}
          rows={rows}
        />
      </Card>
    </>
  );
}
