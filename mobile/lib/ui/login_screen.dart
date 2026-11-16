import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../core/auth_session.dart';

/// Екран входу. Нічого не знає про навігацію: після успіху сеанс повідомляє
/// про зміну, а застосунок сам відкриває список.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.session});

  final AuthSession session;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _name = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _password.dispose();
    super.dispose();
  }

  /// Текст для користувача. Сервер не каже, чи існує ім'я, і застосунок
  /// теж: на 401 одне повідомлення.
  String _explain(ApiException e) => switch (e.status) {
    401 => 'Невірне ім’я користувача або пароль',
    429 =>
      e.retryAfter == null
          ? 'Забагато спроб. Спробуйте пізніше'
          : 'Забагато спроб. Повторіть через ${e.retryAfter!.inSeconds} с',
    0 => 'Немає зв’язку із сервером',
    _ => 'Сервер тимчасово недоступний. Спробуйте ще раз',
  };

  Future<void> _submit() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.session.signIn(_name.text.trim(), _password.text);
    } on ApiException catch (e) {
      if (!mounted) return;
      _password.clear(); // пароль після відмови не лишається на екрані
      setState(() => _error = _explain(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Вхід')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 360),
          child: AutofillGroup(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextField(
                    controller: _name,
                    autofillHints: const [AutofillHints.username],
                    textInputAction: TextInputAction.next,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: 'Ім’я користувача',
                    ),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _password,
                    autofillHints: const [AutofillHints.password],
                    obscureText: true,
                    enableSuggestions: false,
                    autocorrect: false,
                    onSubmitted: (_) => _submit(),
                    decoration: const InputDecoration(labelText: 'Пароль'),
                  ),
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: Text(
                        _error!,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ),
                  const SizedBox(height: 16),
                  FilledButton(
                    onPressed: _busy ? null : _submit,
                    child: Text(_busy ? 'Входимо…' : 'Увійти'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
